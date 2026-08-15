function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function topicTerms(query) {
  return String(query || '')
    .replace(/"[^"]*"/g, match => ` ${match.slice(1, -1)} `)
    .replace(/(^|\s)-?(?:from|to|lang|since|until|filter|is):\S+/gi, ' ')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length > 2 && !['and', 'or', 'not'].includes(term));
}

function topicFit(post) {
  const terms = [...new Set(topicTerms(post?.query))];
  if (!terms.length) return 0;
  const text = String(post?.text || '').toLowerCase();
  const matched = terms.filter(term => text.includes(term)).length;
  return Math.min(12, 4 + matched * 4);
}

export function score(post, now = Date.now()) {
  const publishedAt = new Date(post?.createdAt).getTime();
  const age = Math.max(1, Number.isFinite(publishedAt) ? (now - publishedAt) / 60000 : 180);
  const replies = count(post?.replies);
  const engagement = count(post?.likes) + count(post?.reposts) * 2;
  const freshness = Math.max(0, 50 - age / 3);
  const topic = topicFit(post);
  const openConversation = Math.max(0, 18 - replies * 3);
  const reach = Math.min(6, Math.log10(Math.max(10, count(post?.views))) * 1.5);
  const momentum = Math.min(8, engagement / Math.pow(age + 10, 0.75) * 3);
  return Math.max(1, Math.min(99, Math.round(20 + freshness + topic + openConversation + reach + momentum)));
}
