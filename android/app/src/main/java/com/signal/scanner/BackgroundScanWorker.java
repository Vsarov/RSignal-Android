package com.signal.scanner;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A small, process-independent scan runner. It reads the non-sensitive scan
 * configuration from Capacitor Preferences and the AnyAPI key from the same
 * Android Keystore-backed store used by the WebView plugin.
 */
public final class BackgroundScanWorker extends Worker {
    private static final String ANYAPI_URL = "https://api.getanyapi.com/v1/run/";
    private static final String CONFIG_KEY = "rsignals:background-config";
    private static final String RESULTS_KEY = "rsignals:background-results";
    private static final String SEEN_KEY = "rsignals:seen-posts:v1";
    private static final String FOLLOWER_CACHE_KEY = "rsignals:follower-cache:v1";
    private static final String KEY_ALIAS = "capacitor-storage_rsignals:anyapi-key";
    private static final String PREFERENCES = "CapacitorStorage";
    private static final String SECURE_PREFERENCES = "WSSecureStorageSharedPreferences";
    private static final String NOTIFICATION_CHANNEL = "rsignals-opportunities";
    private static final int NOTIFICATION_ID = 42001;
    private static final long DAY_MS = 24L * 60L * 60L * 1000L;

    public BackgroundScanWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        if (!ScanLease.tryAcquire(getApplicationContext())) return Result.success();
        try {
          try {
            SharedPreferences preferences = getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
            String configured = preferences.getString(CONFIG_KEY, null);
            String apiKey = readSecureKey();
            if (configured == null || apiKey == null || apiKey.trim().isEmpty()) return Result.success();

            JSONObject config = new JSONObject(configured);
            boolean notifyAllowed = config.optBoolean("notificationsEnabled", true) && !inQuietHours(config);
            JSONObject queries = config.optJSONObject("queriesByPlatform");
            JSONArray platforms = config.optJSONArray("platforms");
            if (queries == null || platforms == null) return Result.success();

            int limit = bounded(config.optInt("limit", 12), 1, 50);
            double maxAgeHours = Math.max(0.25d, Math.min(168d, config.optDouble("maxAgeHours", 3d)));
            long now = System.currentTimeMillis();
            JSONObject seen = readJsonObject(preferences.getString(SEEN_KEY, "{}"));
            pruneSeen(seen, now);
            Set<String> inScan = new HashSet<>();
            JSONArray fresh = new JSONArray();
            int attemptedJobs = 0;
            int successfulJobs = 0;
            int retryableFailures = 0;

            for (int platformIndex = 0; platformIndex < platforms.length(); platformIndex++) {
                String platform = platforms.optString(platformIndex, "");
                String sku = sku(platform);
                JSONArray sourceQueries = queries.optJSONArray(platform);
                if (sku == null || sourceQueries == null) continue;
                for (int queryIndex = 0; queryIndex < Math.min(sourceQueries.length(), 12); queryIndex++) {
                    String query = sourceQueries.optString(queryIndex, "").trim();
                    if (query.isEmpty()) continue;
                    ScanLease.renew(getApplicationContext());
                    attemptedJobs++;
                    JSONArray rawItems;
                    try {
                        rawItems = findArray(request(sku, requestBody(platform, query, limit, maxAgeHours), apiKey), 0);
                        successfulJobs++;
                    } catch (IOException error) {
                        if (isRetryableRequest(error)) retryableFailures++;
                        continue;
                    } catch (JSONException error) {
                        // A malformed provider response should not prevent other sources from completing.
                        continue;
                    }
                    for (int itemIndex = 0; itemIndex < rawItems.length(); itemIndex++) {
                        JSONObject raw = rawItems.optJSONObject(itemIndex);
                        if (raw == null || excluded(raw, platform)) continue;
                        JSONObject post = normalize(raw, platform, query, itemIndex);
                        long createdAt = parseTime(post.optString("createdAt", ""));
                        if (createdAt <= 0 || createdAt < now - (long) (maxAgeHours * 60d * 60d * 1000d)) continue;
                        String identity = postKey(post);
                        String legacy = platform.equals("x") ? post.optString("id", "") : "";
                        if (inScan.contains(identity) || seen.has(identity) || (!legacy.isEmpty() && seen.has(legacy))) continue;
                        inScan.add(identity);
                        seen.put(identity, now);
                        fresh.put(post);
                    }
                }
            }
            preferences.edit().putString(SEEN_KEY, seen.toString()).apply();
            JSONArray ordered = sortNewest(fresh);
            if (ordered.length() > 0) preferences.edit().putString(RESULTS_KEY, ordered.toString()).apply();
            enrichFollowersForNotifications(ordered, config.optInt("minFollowers", 0), apiKey, preferences);
            if (notifyAllowed && hasNotifiable(ordered, config, now)) showNotification(ordered.length());
            if (attemptedJobs > 0 && successfulJobs == 0 && retryableFailures > 0) return getRunAttemptCount() < 2 ? Result.retry() : Result.failure();
            return Result.success();
        } catch (IOException error) {
            return getRunAttemptCount() < 2 ? Result.retry() : Result.failure();
        } catch (Exception error) {
            // Configuration and provider-shape failures are not helped by immediate retries.
            return Result.success();
          }
        } finally {
            ScanLease.release(getApplicationContext());
        }
    }

    private static int bounded(int value, int minimum, int maximum) { return Math.max(minimum, Math.min(maximum, value)); }
    private static String sku(String platform) {
        switch (platform) {
            case "x": return "twitter.search";
            case "linkedin": return "linkedin.search_posts_full";
            case "reddit": return "reddit.search";
            case "youtube": return "youtube.search";
            case "tiktok": return "tiktok.hashtag_videos";
            case "substack": return "substack.posts";
            default: return null;
        }
    }

    private static JSONObject requestBody(String platform, String query, int limit, double maxAgeHours) throws JSONException {
        JSONObject result = new JSONObject();
        if (platform.equals("x")) return result.put("query", cleanXQuery(query)).put("limit", limit).put("queryType", "Latest").put("requireSinglePage", false);
        if (platform.equals("linkedin")) return result.put("query", cleanQuery(query)).put("datePosted", maxAgeHours <= 24d ? "last-day" : "last-week").put("sort", "date").put("limit", Math.min(limit, 10));
        if (platform.equals("reddit")) return result.put("query", cleanQuery(query)).put("sort", "new").put("timeframe", "week");
        if (platform.equals("youtube")) return result.put("query", cleanQuery(query)).put("uploadDate", "this_week");
        if (platform.equals("tiktok")) return result.put("hashtag", cleanQuery(query).replaceFirst("^#", "")).put("limit", Math.min(limit, 20));
        return result.put("url", cleanQuery(query)).put("limit", Math.min(limit, 100)).put("includeContent", false);
    }

    private static String cleanQuery(String value) { return value.replaceAll("(?i)(^|\\s)(from|to|lang|since|until|filter):\\S+", " ").replaceAll("\\s+", " ").trim(); }
    private static String cleanXQuery(String value) { return value.replaceAll("(?i)(^|\\s)-is:(repost|retweet)\\b", " ").replace("(", " ").replace(")", " ").replaceAll("(?i)\\bAND\\b", " ").replaceAll("\\s+", " ").trim(); }

    private static final class ProviderException extends IOException {
        final int status;
        ProviderException(int status) { super("AnyAPI response " + status); this.status = status; }
    }

    static boolean isRetryableProviderStatus(int status) { return status == 429 || status >= 500; }
    static boolean isRetryableRequest(IOException error) { return !(error instanceof ProviderException) || isRetryableProviderStatus(((ProviderException) error).status); }

    private JSONObject request(String sku, JSONObject body, String apiKey) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(ANYAPI_URL + sku).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream stream = connection.getOutputStream()) { stream.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String response = read(stream);
        if (status < 200 || status >= 300) throw new ProviderException(status);
        return new JSONObject(response);
    }

    private static String read(InputStream input) throws IOException {
        if (input == null) return "";
        StringBuilder content = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new java.io.InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line; while ((line = reader.readLine()) != null) content.append(line);
        }
        return content.toString();
    }

    private static JSONArray findArray(Object value, int depth) {
        if (depth > 8 || value == null || value == JSONObject.NULL) return new JSONArray();
        if (value instanceof JSONArray) return (JSONArray) value;
        if (!(value instanceof JSONObject)) return new JSONArray();
        JSONObject object = (JSONObject) value;
        String[] preferred = { "posts", "items", "data", "results", "tweets", "videos", "elements", "activities", "output" };
        for (String key : preferred) { JSONArray direct = object.optJSONArray(key); if (direct != null && direct.length() > 0) return direct; }
        for (String key : preferred) { Object nested = object.opt(key); JSONArray found = findArray(nested, depth + 1); if (found.length() > 0) return found; }
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) { JSONArray found = findArray(object.opt(keys.next()), depth + 1); if (found.length() > 0) return found; }
        return new JSONArray();
    }

    private static boolean excluded(JSONObject raw, String platform) {
        JSONObject value = nested(raw, "post", "tweet", "activity");
        String type = first(value, "type", "postType", "contentType").toLowerCase(Locale.ROOT);
        if (type.equals("comment") || type.equals("reply") || type.equals("replied_to") || type.equals("comment_reply") || value.optBoolean("isComment") || value.optBoolean("isReply") || value.has("parentId") || value.has("replyTo")) return true;
        return platform.equals("x") && (type.equals("retweet") || type.equals("retweeted") || type.equals("repost") || type.equals("reposted") || value.optBoolean("isRetweet") || value.optBoolean("isRepost") || first(value, "text", "fullText", "full_text").matches("(?i)^RT\\s+@.*"));
    }

    private static JSONObject normalize(JSONObject raw, String platform, String query, int index) throws JSONException {
        JSONObject post = nested(raw, "post", "tweet", "activity");
        JSONObject author = nested(post, "author", "user", "actor");
        if (author.length() == 0) author = nested(raw, "author", "user");
        String username = first(author, "username", "screen_name", "publicIdentifier");
        if (username.isEmpty()) username = first(post, "username", "screen_name");
        if (username.isEmpty()) username = "unknown";
        username = username.replaceFirst("^@", "").replaceFirst("^u/", "");
        String body = first(post, "full_text", "fullText", "text", "content", "commentary", "title", "caption", "description");
        if (body.isEmpty()) body = first(raw, "title", "text", "caption", "description");
        String id = first(post, "id", "id_str", "activityId", "postId");
        if (id.isEmpty()) id = first(raw, "id", "postId");
        if (id.isEmpty()) id = "content-" + Integer.toUnsignedString((username + "|" + body + "|" + index).hashCode(), 16);
        String url = first(post, "url", "link", "postUrl");
        if (url.isEmpty()) url = first(raw, "url", "link");
        if (url.isEmpty() && raw.has("permalink")) url = "https://www.reddit.com" + raw.optString("permalink");
        if (url.isEmpty()) url = defaultUrl(platform, username, id);
        String timestamp = first(post, "createdAt", "created_at", "createdUtc", "publishedAt", "published_at", "timestamp");
        if (timestamp.isEmpty()) timestamp = first(raw, "createdAt", "created_at", "createdUtc", "publishedAt", "timestamp");
        JSONObject result = new JSONObject();
        result.put("platform", platform).put("id", id).put("query", query).put("text", body).put("url", url).put("createdAt", isoTime(parseTime(timestamp)));
        result.put("replies", number(first(post, "replies", "replyCount", "commentCount", "comments"), number(first(raw, "numComments", "commentCount", "comments"), 0)));
        result.put("likes", number(first(post, "likes", "likeCount", "reactions", "score"), number(first(raw, "likes", "likeCount", "reactionCount", "score"), 0)));
        result.put("reposts", number(first(post, "reposts", "retweetCount", "shares"), number(first(raw, "reposts", "retweetCount", "shareCount"), 0)));
        result.put("views", number(first(post, "views", "viewCount", "playCount"), number(first(raw, "views", "viewCount", "playCount"), 0)));
        JSONObject owner = new JSONObject();
        owner.put("name", nonEmpty(first(author, "name", "fullName"), nonEmpty(first(post, "authorName"), username))).put("username", username)
            .put("profileUrl", first(author, "profileUrl", "url")).put("verified", author.optBoolean("verified") || author.optBoolean("isVerified") || raw.optBoolean("verified"));
        String followers = first(author, "followers", "followerCount", "followers_count");
        if (followers.isEmpty()) followers = first(post, "followers");
        owner.put("followers", followers.isEmpty() ? JSONObject.NULL : number(followers, 0));
        result.put("author", owner);
        return result;
    }

    private static JSONObject nested(JSONObject source, String... keys) { for (String key : keys) { JSONObject candidate = source.optJSONObject(key); if (candidate != null) return candidate; } return new JSONObject(); }
    private static String first(JSONObject object, String... keys) { for (String key : keys) { Object value = object.opt(key); if (value != null && value != JSONObject.NULL && !String.valueOf(value).isEmpty()) return String.valueOf(value); } return ""; }
    private static String nonEmpty(String first, String fallback) { return first.isEmpty() ? fallback : first; }
    private static String defaultUrl(String platform, String user, String id) { if (platform.equals("x")) return "https://x.com/" + user + "/status/" + id; if (platform.equals("linkedin")) return id.matches("\\d+") ? "https://www.linkedin.com/feed/update/urn:li:activity:" + id + "/" : "https://www.linkedin.com/feed/"; if (platform.equals("youtube")) return "https://www.youtube.com/watch?v=" + id; return platform.equals("reddit") ? "https://www.reddit.com/" : platform.equals("tiktok") ? "https://www.tiktok.com/" : "https://substack.com/"; }
    private static int number(String value, int fallback) { try { String normalized = value.trim().replace(",", "").toLowerCase(Locale.ROOT); double multiplier = normalized.endsWith("k") ? 1000d : normalized.endsWith("m") ? 1_000_000d : normalized.endsWith("b") ? 1_000_000_000d : 1d; if (multiplier != 1d) normalized = normalized.substring(0, normalized.length() - 1); double parsed = Double.parseDouble(normalized) * multiplier; return parsed >= 0d && Double.isFinite(parsed) ? (int) Math.min(Integer.MAX_VALUE, Math.round(parsed)) : fallback; } catch (Exception ignored) { return fallback; } }
    private static long parseTime(String value) { try { double raw = Double.parseDouble(value); long absolute = (long) Math.abs(raw); if (absolute < 100_000_000_000L) return (long) (raw * 1000d); if (absolute < 100_000_000_000_000L) return (long) raw; if (absolute < 100_000_000_000_000_000L) return (long) (raw / 1000d); return (long) (raw / 1_000_000d); } catch (Exception ignored) {} for (String format : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX", "yyyy-MM-dd HH:mm:ssZ" }) try { SimpleDateFormat parser = new SimpleDateFormat(format, Locale.US); Date date = parser.parse(value); if (date != null) return date.getTime(); } catch (Exception ignored) {} return -1L; }
    private static String isoTime(long epoch) { if (epoch <= 0) return ""; SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US); format.setTimeZone(TimeZone.getTimeZone("UTC")); return format.format(new Date(epoch)); }
    static String postKey(JSONObject post) {
        String platform = post.optString("platform", "x").toLowerCase(Locale.ROOT);
        String url = post.optString("url", "");
        String key = postKey(platform, post.optString("id", ""), url);
        if (!key.equals(platform + ":url:content:" + Integer.toUnsignedString(url.hashCode(), 16))) return key;
        JSONObject author = post.optJSONObject("author");
        String content = (author == null ? "" : author.optString("username", author.optString("name", ""))) + "|" + post.optString("createdAt", "") + "|" + post.optString("text", "");
        return platform + ":content:" + Integer.toUnsignedString(content.hashCode(), 16);
    }

    static String postKey(String platform, String id, String url) {
        String xId = url.replaceFirst("(?i)^.*(?:x\\.com|twitter\\.com)/[^/]+/status/(\\d+).*$", "$1");
        if (!xId.matches("\\d+")) xId = "";
        String linkedInId = url.replaceFirst("(?i)^.*activity[:-](\\d+).*$", "$1");
        if (!linkedInId.matches("\\d+")) linkedInId = "";
        String stable = !xId.isEmpty() ? xId : !linkedInId.isEmpty() ? linkedInId : !id.startsWith("content-") ? id : "";
        if (!stable.isEmpty()) return platform + ":" + stable;
        return platform + ":url:" + canonicalUrl(url);
    }

    static String canonicalUrl(String url) {
        try {
            URI parsed = new URI(url);
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) throw new IllegalArgumentException("URL host is missing");
            host = host.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
            String path = parsed.getPath();
            if (path == null || path.isEmpty()) path = "/";
            if (path.length() > 1) path = path.replaceAll("/+$", "");
            return new URI("https", null, host, -1, path, null, null).toString();
        } catch (Exception ignored) {
            return "content:" + Integer.toUnsignedString(url.hashCode(), 16);
        }
    }
    private static JSONObject readJsonObject(String value) { try { return new JSONObject(value); } catch (Exception ignored) { return new JSONObject(); } }
    private static void pruneSeen(JSONObject seen, long now) { ArrayList<String> remove = new ArrayList<>(); Iterator<String> keys = seen.keys(); while (keys.hasNext()) { String key = keys.next(); if (seen.optLong(key, 0) < now - 90L * DAY_MS) remove.add(key); } for (String key : remove) seen.remove(key); }
    private static JSONArray sortNewest(JSONArray items) { ArrayList<JSONObject> ordered = new ArrayList<>(); for (int i = 0; i < items.length(); i++) { JSONObject item = items.optJSONObject(i); if (item != null) ordered.add(item); } Collections.sort(ordered, Comparator.comparingLong(value -> -parseTime(value.optString("createdAt", "")))); JSONArray result = new JSONArray(); for (JSONObject item : ordered) result.put(item); return result; }

    private void enrichFollowersForNotifications(JSONArray posts, int minimumFollowers, String apiKey, SharedPreferences preferences) {
        if (minimumFollowers <= 0) return;
        JSONObject cache = readJsonObject(preferences.getString(FOLLOWER_CACHE_KEY, "{}"));
        long now = System.currentTimeMillis();
        for (int index = 0; index < posts.length(); index++) {
            JSONObject post = posts.optJSONObject(index);
            if (post == null) continue;
            String platform = post.optString("platform", "").toLowerCase(Locale.ROOT);
            if (!platform.equals("x") && !platform.equals("linkedin")) continue;
            JSONObject author = post.optJSONObject("author");
            if (author == null || optionalFollower(author.opt("followers")) != null) continue;
            String username = author.optString("username", "").replaceFirst("^@", "").trim();
            String cacheKey = "";
            String sku = "";
            JSONObject body = new JSONObject();
            try {
                if (platform.equals("x") && username.toLowerCase(Locale.ROOT).matches("[a-z0-9_]{1,15}")) {
                    cacheKey = "x:" + username.toLowerCase(Locale.ROOT);
                    sku = "twitter.profile";
                    body.put("handle", username);
                } else if (platform.equals("linkedin")) {
                    String profileUrl = canonicalLinkedInProfileUrl(author.optString("profileUrl", ""));
                    if (profileUrl.isEmpty() && username.toLowerCase(Locale.ROOT).matches("[a-z0-9_-]{2,100}")) profileUrl = "https://www.linkedin.com/in/" + username;
                    if (!profileUrl.isEmpty()) {
                        cacheKey = "linkedin:" + profileUrl.toLowerCase(Locale.ROOT);
                        sku = "linkedin.profile";
                        body.put("url", profileUrl);
                    }
                }
                if (cacheKey.isEmpty()) continue;
                JSONObject cached = cache.optJSONObject(cacheKey);
                Integer followers = cached == null || now - cached.optLong("fetchedAt", 0) >= 24L * 60L * 60L * 1000L ? null : optionalFollower(cached.opt("followers"));
                if (followers == null) {
                    ScanLease.renew(getApplicationContext());
                    followers = extractFollowerCount(request(sku, body, apiKey), platform);
                    cache.put(cacheKey, new JSONObject().put("followers", followers == null ? JSONObject.NULL : followers).put("fetchedAt", System.currentTimeMillis()));
                }
                if (followers != null) author.put("followers", followers);
            } catch (Exception ignored) {
                // Missing or failed profile lookups are not grounds to notify a low-confidence author.
            }
        }
        long cutoff = now - 30L * DAY_MS;
        ArrayList<String> expired = new ArrayList<>();
        Iterator<String> keys = cache.keys();
        while (keys.hasNext()) { String key = keys.next(); JSONObject entry = cache.optJSONObject(key); if (entry == null || entry.optLong("fetchedAt", 0) < cutoff) expired.add(key); }
        for (String key : expired) cache.remove(key);
        preferences.edit().putString(FOLLOWER_CACHE_KEY, cache.toString()).apply();
    }

    private static String canonicalLinkedInProfileUrl(String value) {
        try {
            URI parsed = new URI(value);
            String host = parsed.getHost();
            String path = parsed.getPath();
            if (host == null || !host.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "").equals("linkedin.com") || path == null || !path.matches("(?i)^/in/[^/?#]+/?$")) return "";
            return "https://www.linkedin.com" + path.replaceAll("/+$", "");
        } catch (Exception ignored) { return ""; }
    }

    private static Integer optionalFollower(Object value) {
        if (value == null || value == JSONObject.NULL) return null;
        String raw = String.valueOf(value).trim().replace(",", "").toLowerCase(Locale.ROOT);
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("^(\\d+(?:\\.\\d+)?)\\s*([kmb])?$").matcher(raw);
        if (!match.matches()) return null;
        double multiplier = "k".equals(match.group(2)) ? 1_000d : "m".equals(match.group(2)) ? 1_000_000d : "b".equals(match.group(2)) ? 1_000_000_000d : 1d;
        double parsed = Double.parseDouble(match.group(1)) * multiplier;
        return Double.isFinite(parsed) && parsed >= 0 ? (int) Math.min(Integer.MAX_VALUE, Math.round(parsed)) : null;
    }

    private static Integer extractFollowerCount(JSONObject payload, String platform) {
        JSONObject output = payload.optJSONObject("output");
        JSONObject data = output == null ? payload.optJSONObject("data") : output.optJSONObject("data");
        if (data == null) data = output == null ? payload : output;
        return platform.equals("linkedin")
            ? optionalFollower(first(data, "followerCount", "followersCount", "followers", "follower_count"))
            : optionalFollower(first(data, "followers", "followerCount", "followersCount", "followers_count"));
    }
    static boolean passesNotificationFollowerThreshold(JSONObject post, int minimumFollowers) {
        String platform = post.optString("platform", "");
        JSONObject author = post.optJSONObject("author");
        return passesNotificationFollowerThreshold(platform, author == null ? 0 : author.optInt("followers", 0), minimumFollowers);
    }
    static boolean passesNotificationFollowerThreshold(String platform, int followers, int minimumFollowers) {
        if (minimumFollowers <= 0 || (!platform.equals("x") && !platform.equals("linkedin"))) return true;
        return followers >= minimumFollowers;
    }
    private static boolean hasNotifiable(JSONArray posts, JSONObject config, long now) { int minimumFollowers = config.optInt("minFollowers", 0); int threshold = config.optInt("notifyScore", 70); for (int i = 0; i < posts.length(); i++) { JSONObject post = posts.optJSONObject(i); if (post != null && passesNotificationFollowerThreshold(post, minimumFollowers) && score(post, now) >= threshold) return true; } return false; }
    private static int score(JSONObject post, long now) { long published = parseTime(post.optString("createdAt", "")); double age = Math.max(1d, published > 0 ? (now - published) / 60_000d : 180d); double replies = post.optInt("replies", 0); double engagement = post.optInt("likes", 0) + post.optInt("reposts", 0) * 2d; double freshness = Math.max(0d, 50d - age / 3d); double openConversation = Math.max(0d, 18d - replies * 3d); double reach = Math.min(6d, Math.log10(Math.max(10d, post.optInt("views", 0))) * 1.5d); double momentum = Math.min(8d, engagement / Math.pow(age + 10d, .75d) * 3d); return (int) Math.max(1d, Math.min(99d, Math.round(20d + freshness + openConversation + reach + momentum))); }
    private static boolean inQuietHours(JSONObject config) { if (!config.optBoolean("quietHoursEnabled", false)) return false; Calendar calendar = Calendar.getInstance(); JSONArray days = config.optJSONArray("quietDays"); int day = calendar.get(Calendar.DAY_OF_WEEK) - 1; if (days != null) for (int i = 0; i < days.length(); i++) if (days.optInt(i, -1) == day) return true; int start = minutes(config.optString("quietStart", "22:00")), end = minutes(config.optString("quietEnd", "07:00")); if (start < 0 || end < 0 || start == end) return false; int current = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE); return start < end ? current >= start && current < end : current >= start || current < end; }
    private static int minutes(String value) { try { String[] parts = value.split(":"); int hours = Integer.parseInt(parts[0]), minutes = Integer.parseInt(parts[1]); return hours < 24 && minutes < 60 ? hours * 60 + minutes : -1; } catch (Exception ignored) { return -1; } }

    private String readSecureKey() throws Exception {
        String encrypted = getApplicationContext().getSharedPreferences(SECURE_PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ALIAS, null);
        if (encrypted == null) return null;
        String[] parts = encrypted.split("\\u0010");
        if (parts.length != 2) return null;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null);
        if (entry == null) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) entry.getSecretKey(), new GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_PADDING | Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[0], Base64.NO_PADDING | Base64.NO_WRAP)), StandardCharsets.UTF_8).trim();
    }

    private void showNotification(int count) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getApplicationContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = ContextCompat.getSystemService(getApplicationContext(), NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(NOTIFICATION_CHANNEL, "RSignals opportunities", NotificationManager.IMPORTANCE_DEFAULT));
        Intent intent = new Intent(getApplicationContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(getApplicationContext(), 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.notify(NOTIFICATION_ID, new NotificationCompat.Builder(getApplicationContext(), NOTIFICATION_CHANNEL).setSmallIcon(com.signal.scanner.R.drawable.ic_stat_rsignals).setContentTitle("RSignals found fresh opportunities").setContentText(count + " new result" + (count == 1 ? "" : "s") + " are ready to review.").setContentIntent(pending).setAutoCancel(true).build());
    }
}
