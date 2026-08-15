// Browser- and Node-safe scanner policies. Platform adapters provide storage,
// transport, diagnostics, and UI; these rules deliberately do not.
export function sourceQuery(platform, topic) {
  const clean = String(topic || '').replace(/(^|\s)-is:(?:repost|retweet)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (platform !== 'x') return clean.replace(/(^|\s)(?:from|to|lang|since|until|filter):\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  return clean.replace(/[()]/g, ' ').replace(/\bAND\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function sourceRequest(platform, query, limit, maxAgeHours = 168) {
  if (platform === 'x') return { query, limit, queryType: 'Latest', requireSinglePage: false };
  if (platform === 'linkedin') return { query, datePosted: maxAgeHours <= 24 ? 'last-day' : 'last-week', sort: 'date', limit: Math.min(limit, 10) };
  if (platform === 'reddit') return { query, sort: 'new', timeframe: 'week' };
  if (platform === 'youtube') return { query, uploadDate: 'this_week' };
  if (platform === 'tiktok') return { hashtag: String(query).replace(/^#/, '').trim(), limit: Math.min(limit, 20) };
  if (platform === 'substack') return { url: query, limit: Math.min(limit, 100), includeContent: false };
  return { query };
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function normalizedUrl(value) {
  try {
    const parsed = new URL(String(value));
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch { return ''; }
}

export function postKey(post) {
  const platform = String(post?.platform || 'x').toLowerCase();
  const url = String(post?.url || '');
  const xId = url.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i)?.[1];
  const linkedInId = url.match(/activity[:-](\d+)/i)?.[1];
  const id = String(post?.id || '');
  const stableId = xId || linkedInId || (id && !id.startsWith('content-') ? id : '');
  if (stableId) return `${platform}:${stableId}`;
  const canonical = normalizedUrl(url);
  if (canonical) return `${platform}:url:${canonical}`;
  return `${platform}:content:${stableHash(`${post?.author?.username || post?.author?.name || ''}|${post?.createdAt || ''}|${post?.text || ''}`)}`;
}
