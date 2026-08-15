import test from 'node:test';
import assert from 'node:assert/strict';
import { isInQuietHours, notificationCandidates } from '../public/notification-policy.js';

const now = Date.parse('2026-08-14T12:00:00.000Z');
const post = (overrides = {}) => ({
  platform: 'x',
  author: { name: 'Fixture', followers: 1_000 },
  createdAt: '2026-08-14T11:50:00.000Z',
  text: 'A fresh public opportunity',
  replies: 0,
  likes: 2,
  reposts: 0,
  views: 100,
  ...overrides
});

test('quiet hours handle all-day selections and overnight boundaries', () => {
  assert.equal(isInQuietHours({ quietHoursEnabled: true, quietDays: [5], quietStart: '22:00', quietEnd: '07:00' }, new Date('2026-08-14T12:00:00')), true);
  assert.equal(isInQuietHours({ quietHoursEnabled: true, quietDays: [], quietStart: '22:00', quietEnd: '07:00' }, new Date('2026-08-14T23:00:00')), true);
  assert.equal(isInQuietHours({ quietHoursEnabled: true, quietDays: [], quietStart: '22:00', quietEnd: '07:00' }, new Date('2026-08-14T06:59:00')), true);
  assert.equal(isInQuietHours({ quietHoursEnabled: true, quietDays: [], quietStart: '22:00', quietEnd: '07:00' }, new Date('2026-08-14T07:00:00')), false);
  assert.equal(isInQuietHours({ quietHoursEnabled: false, quietDays: [5], quietStart: '22:00', quietEnd: '07:00' }, new Date('2026-08-14T12:00:00')), false);
});

test('notification candidates honor enablement, quiet hours, follower and score thresholds', () => {
  const settings = { notificationsEnabled: true, quietHoursEnabled: false, quietDays: [], quietStart: '22:00', quietEnd: '07:00', minFollowers: 500, notifyScore: 70 };
  const strong = post({ author: { name: 'Strong', followers: 1_000 } });
  const followerMiss = post({ author: { name: 'Small', followers: 100 } });
  const scoreMiss = post({ author: { name: 'Old', followers: 1_000 }, createdAt: '2026-08-13T01:00:00.000Z', replies: 10, likes: 0, reposts: 0, views: 0 });
  assert.deepEqual(notificationCandidates([strong, followerMiss, scoreMiss], settings, now).map(item => item.author.name), ['Strong']);
  assert.deepEqual(notificationCandidates([strong], { ...settings, notificationsEnabled: false }, now), []);
  assert.deepEqual(notificationCandidates([strong], { ...settings, quietHoursEnabled: true, quietDays: [5] }, now), []);
});

test('notification candidates preserve non-X follower semantics and sort strongest first', () => {
  const settings = { notificationsEnabled: true, quietHoursEnabled: false, quietDays: [], quietStart: '22:00', quietEnd: '07:00', minFollowers: 10_000, notifyScore: 1 };
  const linkedIn = post({ platform: 'linkedin', author: { name: 'LinkedIn', followers: 15_000 }, likes: 10 });
  const reddit = post({ platform: 'reddit', author: { name: 'Reddit', followers: null }, likes: 50 });
  const x = post({ platform: 'x', author: { name: 'X', followers: 20_000 }, likes: 1 });
  assert.deepEqual(notificationCandidates([x, reddit, linkedIn], settings, now).map(item => item.author.name), ['Reddit', 'LinkedIn', 'X']);
});
