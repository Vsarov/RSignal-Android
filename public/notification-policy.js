import { score } from './scoring.js';

function timeMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function isInQuietHours(settings = {}, date = new Date()) {
  if (!settings.quietHoursEnabled) return false;
  const start = timeMinutes(settings.quietStart);
  const end = timeMinutes(settings.quietEnd);
  const days = Array.isArray(settings.quietDays) ? settings.quietDays.map(Number) : [];
  if (days.includes(date.getDay())) return true;
  if (start === null || end === null || start === end) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function passesFollowerFilter(post, minFollowers = 0) {
  if (Number(minFollowers) <= 0 || !['x', 'linkedin'].includes(post?.platform)) return true;
  const followers = Number(post?.author?.followers);
  return Number.isFinite(followers) && followers >= Number(minFollowers);
}

export function notificationCandidates(posts, settings = {}, now = Date.now()) {
  if (!settings.notificationsEnabled || isInQuietHours(settings)) return [];
  return [...(Array.isArray(posts) ? posts : [])]
    .filter(post => passesFollowerFilter(post, settings.minFollowers) && score(post, now) >= Number(settings.notifyScore || 0))
    .sort((left, right) => score(right, now) - score(left, now));
}
