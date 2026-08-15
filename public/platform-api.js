import { postKey as sharedPostKey, sourceQuery, sourceRequest } from './shared/scanner-policy.js';

export { sourceQuery, sourceRequest };

const ANYAPI_URL = 'https://api.getanyapi.com/v1/run/';
const KEY_NAME = 'rsignals:anyapi-key';
const SECURE_KEY_NAME = `capacitor-storage_${KEY_NAME}`;
const SEEN_KEY = 'rsignals:seen-posts:v1';
const BACKGROUND_CONFIG_KEY = 'rsignals:background-config';
const BACKGROUND_RESULTS_KEY = 'rsignals:background-results';
const FOLLOWER_CACHE_KEY = 'rsignals:follower-cache:v1';
const FOLLOWER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLATFORMS = new Set(['x', 'linkedin', 'reddit', 'youtube', 'tiktok', 'substack']);
const skus = { x: 'twitter.search', linkedin: 'linkedin.search_posts_full', reddit: 'reddit.search', youtube: 'youtube.search', tiktok: 'tiktok.hashtag_videos', substack: 'substack.posts' };
const EXTERNAL_HOSTS = new Set(['x.com', 'twitter.com', 'linkedin.com', 'reddit.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'substack.com', 'getanyapi.com', 'chatgpt.com', 'auth.openai.com', 'platform.openai.com']);

export function isNativeAndroid() {
  return Boolean(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'android');
}

export function canOpenExternal(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return EXTERNAL_HOSTS.has(host) || host.endsWith('.substack.com');
  } catch { return false; }
}

function plugin(name) {
  return window.Capacitor?.registerPlugin?.(name);
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function errorMessage(error) {
  return String(error?.message || error || 'Request failed').replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
}

function keyStore() {
  const secure = plugin('SecureStorage');
  if (!secure) throw new Error('Secure storage is unavailable.');
  return secure;
}

async function withNativeScanLease(work) {
  const coordinator = plugin('ScanCoordinator');
  if (!coordinator?.acquire || !coordinator?.release) return work();
  const lease = await coordinator.acquire();
  if (!lease?.acquired) return response(409, { error: 'A scheduled scan is already running. Try again shortly.', scanInProgress: true });
  try { return await work(); }
  finally { try { await coordinator.release(); } catch {} }
}

async function getKey() {
  // SecureStorage's convenience `getItem` wrapper lives in its npm module,
  // which cannot be imported from Electron's raw static server. Call the
  // plugin's annotated native methods directly, using its documented prefix.
  const result = await keyStore().internalGetItem({ prefixedKey: SECURE_KEY_NAME });
  return String(result?.data || '').trim();
}

async function setKey(value) {
  await keyStore().internalSetItem({ prefixedKey: SECURE_KEY_NAME, data: String(value).trim() });
}

async function getSeen() {
  const preferences = plugin('Preferences');
  const stored = await preferences?.get({ key: SEEN_KEY });
  try { return JSON.parse(stored?.value || '{}'); } catch { return {}; }
}

async function setSeen(seen) {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const retained = Object.fromEntries(Object.entries(seen).filter(([, at]) => Number(at) >= cutoff));
  await plugin('Preferences')?.set({ key: SEEN_KEY, value: JSON.stringify(retained) });
}

function bounded(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || fallback));
}

function pickArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const candidate of [value.items, value.data, value.results, value.tweets, value.posts, value.videos, value.elements, value.activities]) {
    const found = pickArray(candidate);
    if (found.length) return found;
  }
  for (const candidate of Object.values(value)) { const found = pickArray(candidate); if (found.length) return found; }
  return [];
}

function itemsFor(platform, payload) {
  if (platform === 'linkedin') return pickArray(payload?.output?.data?.posts || payload?.output?.posts || payload?.data?.posts || payload?.posts);
  return pickArray(payload?.output);
}

function date(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return date(value.value ?? value.timestamp ?? value.createdAt ?? value.created_at ?? value.publishedAt);
  const number = Number(value);
  if (Number.isFinite(number) && number > 0 && String(value).trim() !== '') {
    const absolute = Math.abs(number);
    const milliseconds = absolute < 100_000_000_000 ? number * 1000 : absolute < 100_000_000_000_000 ? number : absolute < 100_000_000_000_000_000 ? number / 1000 : number / 1_000_000;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function count(value) {
  const match = String(value ?? '').trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return 0;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[String(match[2] || '').toLowerCase()] || 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function text(value) { return typeof value === 'object' && value ? String(value.text ?? value.content ?? value.description ?? '') : String(value ?? ''); }
function hash(value) { let result = 2166136261; for (const character of String(value)) result = Math.imul(result ^ character.charCodeAt(0), 16777619); return (result >>> 0).toString(16); }
function first(...values) { return values.find(value => value !== undefined && value !== null && value !== ''); }

function normalize(platform, raw, query, index) {
  const post = raw?.post || raw?.tweet || raw?.activity || raw || {};
  const author = post.author || post.user || post.actor || raw?.author || raw?.user || {};
  const username = String(first(author.username, author.screen_name, author.publicIdentifier, post.username, post.screen_name, raw.username, raw.authorHandle, raw.author, 'unknown')).replace(/^@|^u\//, '');
  const body = text(first(post.full_text, post.fullText, post.text, post.content, post.commentary, post.title, raw.title, raw.text, raw.caption, raw.description));
  const id = String(first(post.id, post.id_str, post.activityId, post.postId, raw.id, raw.postId, `content-${hash(`${username}|${body}`)}-${index}`));
  const urls = {
    x: `https://x.com/${username}/status/${id}`,
    linkedin: /^\d+$/.test(id) ? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/` : 'https://www.linkedin.com/feed/',
    reddit: 'https://www.reddit.com/', youtube: `https://www.youtube.com/watch?v=${id}`, tiktok: 'https://www.tiktok.com/', substack: 'https://substack.com/'
  };
  const permalink = raw.permalink ? `https://www.reddit.com${String(raw.permalink).startsWith('/') ? '' : '/'}${raw.permalink}` : '';
  const url = String(first(post.url, post.link, post.postUrl, raw.url, raw.link, permalink, urls[platform]));
  const followers = first(author.followers, author.followerCount, author.followers_count, post.followers, raw.followers, raw.followerCount);
  return {
    platform, id, query,
    author: { name: String(first(author.name, author.fullName, post.authorName, raw.authorName, username)), username, profileUrl: String(first(author.profileUrl, author.url, platform === 'x' && username !== 'unknown' ? `https://x.com/${username}` : platform === 'linkedin' && username !== 'unknown' ? `https://www.linkedin.com/in/${username}` : '')), verified: Boolean(first(author.verified, author.isVerified, raw.verified, false)), followers: followers === undefined ? null : count(followers) },
    text: body, url,
    createdAt: date(first(post.createdAt, post.created_at, post.createdUtc, post.publishedAt, post.published_at, post.timestamp, raw.createdAt, raw.created_at, raw.createdUtc, raw.publishedAt, raw.timestamp)),
    replies: count(first(post.replies, post.replyCount, post.commentCount, post.comments, raw.numComments, raw.commentCount, raw.comments, 0)),
    likes: count(first(post.likes, post.likeCount, post.reactions, post.score, raw.likes, raw.likeCount, raw.reactionCount, raw.score, 0)),
    reposts: count(first(post.reposts, post.retweetCount, post.shares, raw.reposts, raw.retweetCount, raw.shareCount, 0)),
    views: count(first(post.views, post.viewCount, post.playCount, raw.views, raw.viewCount, raw.playCount, 0))
  };
}

function isExcluded(raw, platform) {
  const value = raw?.post || raw?.tweet || raw || {};
  const type = String(first(value.type, value.postType, value.contentType, '')).toLowerCase();
  if (['comment', 'reply', 'replied_to', 'comment_reply'].includes(type) || value.isComment || value.isReply || value.parentId || value.replyTo) return true;
  if (platform !== 'x') return false;
  if (['retweet', 'retweeted', 'repost', 'reposted'].includes(type) || value.isRetweet || value.isRepost) return true;
  return /^RT\s+@/i.test(String(first(value.text, value.fullText, value.full_text, '')));
}

export function postKey(post) {
  return sharedPostKey(post);
}

async function requestAnyApi(sku, data, key) {
  const http = plugin('CapacitorHttp');
  const result = await http.request({ url: `${ANYAPI_URL}${sku}`, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, data, connectTimeout: 20_000, readTimeout: 30_000 });
  if (result.status < 200 || result.status >= 300) throw new Error(`AnyAPI ${sku} request failed (${result.status}).`);
  return result.data;
}

function canonicalLinkedInProfileUrl(value) {
  try {
    const parsed = new URL(String(value));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'linkedin.com' || !/^\/in\/[^/?#]+\/?$/i.test(parsed.pathname)) return '';
    return `https://www.linkedin.com${parsed.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

function followerLookup(author = {}) {
  const platform = String(author.platform || '').toLowerCase();
  const username = String(author.username || '').replace(/^@/, '').trim();
  if (platform === 'x' && username.toLowerCase() !== 'unknown' && /^[A-Za-z0-9_]{1,15}$/.test(username)) return { platform, username, profileUrl: `https://x.com/${username}`, cacheKey: `x:${username.toLowerCase()}`, sku: 'twitter.profile', data: { handle: username } };
  if (platform === 'linkedin') {
    const fallback = username.toLowerCase() !== 'unknown' && /^[A-Za-z0-9_-]{2,100}$/.test(username) ? `https://www.linkedin.com/in/${username}` : '';
    const profileUrl = canonicalLinkedInProfileUrl(author.profileUrl) || canonicalLinkedInProfileUrl(fallback);
    if (profileUrl) return { platform, username, profileUrl, cacheKey: `linkedin:${profileUrl.toLowerCase()}`, sku: 'linkedin.profile', data: { url: profileUrl } };
  }
  return null;
}

function optionalFollowers(value) {
  const match = String(value ?? '').trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[String(match[2] || '').toLowerCase()] || 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function extractFollowerCount(payload, platform) {
  const data = payload?.output?.data ?? payload?.data ?? payload?.output ?? {};
  return platform === 'linkedin'
    ? optionalFollowers(first(data.followerCount, data.followersCount, data.followers, data.follower_count))
    : optionalFollowers(first(data.followers, data.followerCount, data.followersCount, data.followers_count));
}

async function followerProfiles(authors) {
  const key = await getKey();
  if (!key) return { profiles: [], costUsd: 0, lookups: 0, failures: 0 };
  const preferences = plugin('Preferences');
  const stored = await preferences?.get({ key: FOLLOWER_CACHE_KEY });
  let cache;
  try { cache = JSON.parse(stored?.value || '{}'); } catch { cache = {}; }
  const now = Date.now(), profiles = [], pending = [], seen = new Set();
  for (const author of Array.isArray(authors) ? authors : []) {
    const lookup = followerLookup(author);
    if (!lookup || seen.has(lookup.cacheKey)) continue;
    seen.add(lookup.cacheKey);
    const embedded = optionalFollowers(author.followers);
    if (embedded !== null) { cache[lookup.cacheKey] = { followers: embedded, fetchedAt: now }; profiles.push({ ...lookup, followers: embedded, cached: true }); continue; }
    const cached = cache[lookup.cacheKey];
    const followers = optionalFollowers(cached?.followers);
    if (followers !== null && now - Number(cached?.fetchedAt) < FOLLOWER_CACHE_MAX_AGE_MS) { profiles.push({ ...lookup, followers, cached: true }); continue; }
    pending.push(lookup);
  }
  let cursor = 0, costUsd = 0, failures = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const lookup = pending[cursor++];
      try {
        const payload = await requestAnyApi(lookup.sku, lookup.data, key);
        const followers = extractFollowerCount(payload, lookup.platform);
        cache[lookup.cacheKey] = { followers, fetchedAt: Date.now() };
        costUsd += Number(payload?.costUsd) || 0;
        if (followers !== null) profiles.push({ ...lookup, followers, cached: false });
      } catch { failures++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const retained = Object.fromEntries(Object.entries(cache).filter(([, entry]) => Number(entry?.fetchedAt) >= cutoff));
  await preferences?.set({ key: FOLLOWER_CACHE_KEY, value: JSON.stringify(retained) });
  return { profiles: profiles.map(({ sku, data, cacheKey, ...profile }) => profile), costUsd, lookups: pending.length, failures };
}

function demoPosts(platform, query, limit) {
  return Array.from({ length: Math.min(limit, 3) }, (_, index) => ({ platform, id: `demo-${platform}-${hash(query)}-${index}`, query, author: { name: `${platform === 'linkedin' ? 'LinkedIn' : platform === 'x' ? 'X' : platform} demo author`, username: 'demo', profileUrl: '', verified: false, followers: 500 + index * 100 }, text: `Demo opportunity about ${query}. This is a locally generated preview until you add an AnyAPI key.`, url: 'https://getanyapi.com/', createdAt: new Date(Date.now() - index * 600_000).toISOString(), replies: index, likes: 4 + index, reposts: 0, views: 100 + index * 50 }));
}

async function scan(body) {
  const limit = bounded(body.limit, 12, 1, 50);
  const maxAgeHours = bounded(body.maxAgeHours, 3, 0.25, 168);
  const platforms = [...new Set((Array.isArray(body.platforms) ? body.platforms : []).filter(platform => PLATFORMS.has(platform)))];
  if (!platforms.length) return response(400, { error: 'Choose at least one source.' });
  const queriesByPlatform = body.queriesByPlatform || {};
  const jobs = platforms.flatMap(platform => (Array.isArray(queriesByPlatform[platform]) ? queriesByPlatform[platform] : []).map(query => String(query).trim()).filter(Boolean).slice(0, 12).map(query => ({ platform, query })));
  if (!jobs.length) return response(400, { error: 'Add at least one watchlist topic for a selected source.' });
  const key = await getKey();
  const seen = await getSeen();
  const now = Date.now();
  const failures = [];
  const all = [];
  if (!key) {
    for (const job of jobs) all.push(...demoPosts(job.platform, job.query, limit));
  } else {
    await Promise.all(jobs.map(async job => {
      try {
        const payload = await requestAnyApi(skus[job.platform], sourceRequest(job.platform, sourceQuery(job.platform, job.query), limit, maxAgeHours), key);
        all.push(...itemsFor(job.platform, payload).filter(raw => !isExcluded(raw, job.platform)).map((raw, index) => normalize(job.platform, raw, job.query, index)));
      } catch (error) { failures.push({ platform: job.platform, query: job.query, error: errorMessage(error) }); }
    }));
  }
  const stats = { alreadySeen: 0, tooOld: 0, missingDate: 0, failures, byPlatform: Object.fromEntries(platforms.map(platform => [platform, { new: 0 }])) };
  const fresh = [];
  const keys = new Set();
  for (const post of all) {
    const created = Date.parse(post.createdAt || '');
    if (!Number.isFinite(created)) { stats.missingDate++; continue; }
    if (created < now - maxAgeHours * 3_600_000) { stats.tooOld++; continue; }
    const identity = postKey(post);
    const legacy = identity.startsWith('x:') ? identity.slice(2) : '';
    if (keys.has(identity) || seen[identity] || (legacy && seen[legacy])) { stats.alreadySeen++; continue; }
    keys.add(identity); seen[identity] = now; fresh.push(post); stats.byPlatform[post.platform].new++;
  }
  await setSeen(seen);
  fresh.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (key && !fresh.length && failures.length === jobs.length) return response(502, { error: 'All source requests failed.', stats });
  return response(200, { posts: fresh, stats, demo: !key });
}

export async function apiFetch(path, init = {}) {
  if (!isNativeAndroid()) return fetch(path, init);
  const method = String(init.method || 'GET').toUpperCase();
  let body = {};
  try { body = init.body ? JSON.parse(init.body) : {}; } catch { return response(400, { error: 'Invalid request body.' }); }
  try {
    if (path === '/api/status' && method === 'GET') return response(200, { configured: Boolean(await getKey()), version: '1.5.0', skus });
    if (path === '/api/key' && method === 'POST') { const key = String(body.key || '').trim().replace(/^Bearer\s+/i, ''); if (!key) return response(400, { error: 'Enter an AnyAPI key.' }); await setKey(key); return response(200, { configured: true }); }
    if (path === '/api/key' && method === 'DELETE') { await keyStore().internalRemoveItem({ prefixedKey: SECURE_KEY_NAME }); return response(200, { configured: false }); }
    if (path === '/api/search' && method === 'POST') return withNativeScanLease(() => scan(body));
    if (path === '/api/followers' && method === 'POST') return response(200, await followerProfiles(body.authors));
    if (path === '/api/ai/status') return response(200, { available: false, connected: false, error: 'AI Assist is available in the Windows app only.' });
    if (path.startsWith('/api/ai/')) return response(503, { error: 'AI Assist is unavailable on Android.' });
  } catch (error) { return response(500, { error: errorMessage(error) }); }
  return response(404, { error: 'Unsupported Android API route.' });
}

export async function syncBackgroundConfig(config) {
  if (!isNativeAndroid()) return;
  await plugin('Preferences')?.set({ key: BACKGROUND_CONFIG_KEY, value: JSON.stringify(config) });
}

export async function consumeBackgroundResults() {
  if (!isNativeAndroid()) return [];
  const preferences = plugin('Preferences');
  const stored = await preferences?.get({ key: BACKGROUND_RESULTS_KEY });
  await preferences?.remove({ key: BACKGROUND_RESULTS_KEY });
  try {
    const parsed = JSON.parse(stored?.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function openExternal(url) {
  if (!canOpenExternal(url)) return false;
  if (!isNativeAndroid()) return window.open(url, '_blank', 'noopener,noreferrer');
  return plugin('Browser')?.open({ url });
}

export async function notify(payload) {
  if (!isNativeAndroid()) return false;
  const notifications = plugin('LocalNotifications');
  const permission = await notifications?.requestPermissions();
  if (permission?.display !== 'granted') return false;
  await notifications.schedule({ notifications: [{ id: Math.floor(Date.now() % 2_000_000_000), title: payload.title || 'RSignals', body: payload.body || 'Fresh opportunities found.', extra: { url: payload.url || '' } }] });
  return true;
}

export async function configureNativePlatform() {
  if (!isNativeAndroid()) return;
  document.documentElement.classList.add('native-android');
  const hint = document.querySelector('#credentialHint');
  if (hint) hint.textContent = 'Stored with Android Keystore-backed encryption. RSignals never signs into social accounts.';
  const notificationLabel = document.querySelector('#notificationsEnabled + span');
  if (notificationLabel) notificationLabel.textContent = 'Show Android notifications';
  const notificationDescription = document.querySelector('#notificationsEnabled')?.closest('.settings-group')?.querySelector('.settings-group-head p');
  if (notificationDescription) notificationDescription.textContent = 'Use Android notifications to call attention to strong matches.';
  document.querySelector('#startWithWindows')?.closest('.settings-group')?.classList.add('hidden');
  const intervalLabel = document.querySelector('#scanIntervalLabel');
  if (intervalLabel) intervalLabel.textContent = 'Foreground scan interval';
  document.querySelector('#androidScheduleHint')?.classList.remove('hidden');
  const app = plugin('App');
  await app?.addListener('backButton', () => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog) return dialog.close();
    const active = document.querySelector('.nav.active');
    if (active?.dataset.view !== 'feed') document.querySelector('.nav[data-view="feed"]')?.click();
  });
  const notifications = plugin('LocalNotifications');
  await notifications?.addListener('localNotificationActionPerformed', event => { const url = event?.notification?.extra?.url; if (url) void openExternal(url); });
}
