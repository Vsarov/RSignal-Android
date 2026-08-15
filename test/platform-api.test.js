import test from 'node:test';
import assert from 'node:assert/strict';
import { postKey as desktopPostKey, sourceRequest as desktopSourceRequest } from '../server.js';
import { apiFetch, canOpenExternal, configureNativePlatform, consumeBackgroundResults, isNativeAndroid, postKey as androidPostKey, scanProgressively, sourceRequest as androidSourceRequest, sourceQuery as androidSourceQuery, syncBackgroundConfig } from '../public/platform-api.js';

test('Android source requests preserve desktop AnyAPI request semantics', () => {
  for (const [platform, query, limit, age] of [
    ['x', 'AI agents', 12, 3], ['linkedin', 'AI agents', 12, 24], ['reddit', 'AI agents', 12, 24],
    ['youtube', 'Microsoft Copilot', 12, 24], ['tiktok', '#aiagents', 12, 24], ['substack', 'https://example.substack.com', 12, 24]
  ]) assert.deepEqual(androidSourceRequest(platform, query, limit, age), desktopSourceRequest(platform, query, limit, age));
  assert.equal(androidSourceQuery('linkedin', 'from:fixture "AI agents" -is:retweet'), '"AI agents"');
});

test('Android detection handles a Capacitor localhost WebView before bridge promotion', () => {
  globalThis.window = { location: { hostname: 'localhost', port: '' }, Capacitor: { getPlatform: () => 'web' } };
  assert.equal(isNativeAndroid(), true);
});

test('Android seen keys remain compatible with desktop canonical identity', () => {
  const cases = [
    { platform: 'x', id: 'not-used', url: 'https://twitter.com/fixture/status/1234567890123456789?utm=test', text: 'fixture' },
    { platform: 'linkedin', id: 'not-used', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7490772107048464384/', text: 'fixture' },
    { platform: 'reddit', id: 't3_fixture', url: 'https://www.reddit.com/r/example/comments/fixture/?utm=1', text: 'fixture' },
    { platform: 'youtube', id: 'content-fallback', url: 'https://example.invalid/post/?ignored=1', text: 'fixture' },
    { platform: 'substack', id: 'content-fallback', url: 'http://www.example.invalid/post/?ignored=1', text: 'fixture' }
  ];
  for (const post of cases) assert.equal(androidPostKey(post), desktopPostKey(post));
});

test('Android demo scans persist seen identities and avoid duplicate alerts', async () => {
  const secure = new Map();
  const preferences = new Map();
  const plugins = {
    SecureStorage: { internalGetItem: async ({ prefixedKey }) => ({ data: secure.get(prefixedKey) || null }), internalSetItem: async ({ prefixedKey, data }) => secure.set(prefixedKey, data), internalRemoveItem: async ({ prefixedKey }) => ({ success: secure.delete(prefixedKey) }) },
    Preferences: { get: async ({ key }) => ({ value: preferences.get(key) || null }), set: async ({ key, value }) => preferences.set(key, value) }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const body = { queriesByPlatform: { x: ['enterprise AI'] }, platforms: ['x'], limit: 12, maxAgeHours: 3 };
  const first = await (await apiFetch('/api/search', { method: 'POST', body: JSON.stringify(body) })).json();
  const second = await (await apiFetch('/api/search', { method: 'POST', body: JSON.stringify(body) })).json();
  assert.equal(first.demo, true);
  assert.equal(first.posts.length, 3);
  assert.equal(second.posts.length, 0);
  assert.equal(second.stats.alreadySeen, 3);
  assert.ok(preferences.get('rsignals:seen-posts:v1'));
});

test('Android progressive scans yield each watchlist job before the batch completes', async () => {
  const preferences = new Map();
  const plugins = {
    SecureStorage: { internalGetItem: async () => ({ data: null }) },
    Preferences: { get: async ({ key }) => ({ value: preferences.get(key) || null }), set: async ({ key, value }) => preferences.set(key, value) }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const batches = [];
  const result = await scanProgressively({ queriesByPlatform: { x: ['first topic', 'second topic'] }, platforms: ['x'], limit: 12, maxAgeHours: 3 }, batch => {
    batches.push({ completed: batch.completed, total: batch.total, posts: batch.posts.length, query: batch.job.query });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(batches, [
    { completed: 1, total: 2, posts: 3, query: 'first topic' },
    { completed: 2, total: 2, posts: 3, query: 'second topic' }
  ]);
  assert.equal(result.posts.length, 6);
});

test('Android foreground scans defer when the native background lease is held', async () => {
  const plugins = {
    ScanCoordinator: { acquire: async () => ({ acquired: false, expiresAt: Date.now() + 60_000 }), release: async () => { throw new Error('release should not run'); } }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const result = await apiFetch('/api/search', { method: 'POST', body: JSON.stringify({ platforms: ['x'], queriesByPlatform: { x: ['enterprise AI'] } }) });
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: 'A scheduled scan is already running. Try again shortly.', scanInProgress: true });
});

test('Android scans continue when the optional coordinator is not implemented', async () => {
  const preferences = new Map();
  const plugins = {
    ScanCoordinator: { acquire: async () => { throw new Error('"ScanCoordinator" plugin is not implemented on android'); }, release: async () => {} },
    SecureStorage: { internalGetItem: async () => ({ data: null }) },
    Preferences: { get: async ({ key }) => ({ value: preferences.get(key) || null }), set: async ({ key, value }) => preferences.set(key, value) }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const result = await apiFetch('/api/search', { method: 'POST', body: JSON.stringify({ platforms: ['x'], queriesByPlatform: { x: ['enterprise AI'] } }) });
  const payload = await result.json();
  assert.equal(result.status, 200);
  assert.equal(payload.demo, true);
  assert.equal(payload.posts.length, 3);
});

test('Android live scans use native HTTP and normalize a fresh source result', async () => {
  const secure = new Map([['capacitor-storage_rsignals:anyapi-key', 'fixture-key']]);
  const preferences = new Map();
  let request;
  const plugins = {
    SecureStorage: { internalGetItem: async ({ prefixedKey }) => ({ data: secure.get(prefixedKey) || null }), internalSetItem: async ({ prefixedKey, data }) => secure.set(prefixedKey, data), internalRemoveItem: async ({ prefixedKey }) => ({ success: secure.delete(prefixedKey) }) },
    Preferences: { get: async ({ key }) => ({ value: preferences.get(key) || null }), set: async ({ key, value }) => preferences.set(key, value) },
    CapacitorHttp: { request: async options => {
      request = options;
      return { status: 200, data: { output: { data: { posts: [{ id: '7490772107048464384', publishedAt: Math.floor(Date.now() / 1000), commentary: 'A fresh fixture post', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7490772107048464384/', author: { name: 'Fixture author', publicIdentifier: 'fixture-author', followerCount: '1.2K' } }] } } } };
    } }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const payload = await (await apiFetch('/api/search', { method: 'POST', body: JSON.stringify({ queriesByPlatform: { linkedin: ['enterprise AI'] }, platforms: ['linkedin'], limit: 12, maxAgeHours: 3 }) })).json();
  assert.equal(request.url, 'https://api.getanyapi.com/v1/run/linkedin.search_posts_full');
  assert.equal(request.headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(request.data, { query: 'enterprise AI', datePosted: 'last-day', sort: 'date', limit: 10 });
  assert.equal(payload.demo, false);
  assert.equal(payload.posts.length, 1);
  assert.equal(payload.posts[0].author.followers, 1200);
  assert.equal(payload.posts[0].platform, 'linkedin');
});

test('Android key saving uses SecureStorage native methods and its prefixed key', async () => {
  const secure = new Map();
  const securePlugin = {
    internalGetItem: async ({ prefixedKey }) => ({ data: secure.get(prefixedKey) || null }),
    internalSetItem: async ({ prefixedKey, data }) => secure.set(prefixedKey, data),
    internalRemoveItem: async ({ prefixedKey }) => ({ success: secure.delete(prefixedKey) })
  };
  const plugins = {
    SecureStorage: new Proxy(securePlugin, { get: (target, property) => property === 'then' ? () => { throw new Error('The Capacitor plugin proxy must not be awaited.'); } : target[property] })
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const saved = await apiFetch('/api/key', { method: 'POST', body: JSON.stringify({ key: 'fixture-key' }) });
  assert.equal(saved.ok, true);
  assert.equal(secure.get('capacitor-storage_rsignals:anyapi-key'), 'fixture-key');
  assert.equal((await (await apiFetch('/api/status')).json()).configured, true);
});

test('Android AI Assist uses a Keystore-backed OpenAI API key', async () => {
  const secure = new Map();
  const preferencesStore = new Map();
  const requests = [];
  const plugins = {
    SecureStorage: {
      internalGetItem: async ({ prefixedKey }) => ({ data: secure.get(prefixedKey) || null }),
      internalSetItem: async ({ prefixedKey, data }) => secure.set(prefixedKey, data),
      internalRemoveItem: async ({ prefixedKey }) => ({ success: secure.delete(prefixedKey) })
    },
    Preferences: {
      get: async ({ key }) => ({ value: preferencesStore.get(key) || null }),
      set: async ({ key, value }) => preferencesStore.set(key, value)
    },
    CapacitorHttp: { request: async options => {
      requests.push(options);
      return { status: 200, data: { choices: [{ message: { content: JSON.stringify({ relevance: 'high', relevanceScore: 88, summary: 'Useful discussion.', whyNow: 'It is fresh and unanswered.', suggestedReplies: [{ style: 'helpful', text: 'Here is a practical suggestion.' }, { style: 'curious', text: 'What constraint matters most here?' }, { style: 'concise', text: 'A useful angle is to test this early.' }] }) } }] } };
    } }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const initial = await (await apiFetch('/api/ai/status')).json();
  assert.equal(initial.available, true);
  assert.equal(initial.connected, false);
  const connected = await (await apiFetch('/api/ai/login/key', { method: 'POST', body: JSON.stringify({ apiKey: 'sk-android-fixture' }) })).json();
  assert.equal(connected.connected, true);
  assert.equal(secure.get('capacitor-storage_rsignals:openai-api-key'), 'sk-android-fixture');
  const savedModels = await (await apiFetch('/api/ai/preferences', { method: 'POST', body: JSON.stringify({ models: { summary: 'gpt-5-nano', reply: 'gpt-5.4-mini' } }) })).json();
  assert.deepEqual(savedModels.models, { summary: 'gpt-5-nano', reply: 'gpt-5.4-mini' });
  const result = await (await apiFetch('/api/ai/analyze', { method: 'POST', body: JSON.stringify({ post: { platform: 'x', text: 'A fresh post' }, profile: 'Product builder', instructions: 'Be practical' }) })).json();
  assert.equal(result.relevanceScore, 88);
  assert.equal(result.suggestedReplies.length, 3);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.data.model), ['gpt-5-nano', 'gpt-5.4-mini']);
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-android-fixture');
  assert.equal(requests[0].data.reasoning_effort, 'minimal');
  assert.equal(requests[1].data.reasoning_effort, 'none');
  const loggedOut = await (await apiFetch('/api/ai/logout', { method: 'POST' })).json();
  assert.equal(loggedOut.connected, false);
  assert.equal(secure.has('capacitor-storage_rsignals:openai-api-key'), false);
});

test('Android follower enrichment uses validated profile lookups and durable cache', async () => {
  const secure = new Map([['capacitor-storage_rsignals:anyapi-key', 'fixture-key']]);
  const preferences = new Map();
  let request;
  const plugins = {
    SecureStorage: { internalGetItem: async ({ prefixedKey }) => ({ data: secure.get(prefixedKey) || null }) },
    Preferences: { get: async ({ key }) => ({ value: preferences.get(key) || null }), set: async ({ key, value }) => preferences.set(key, value) },
    CapacitorHttp: { request: async options => { request = options; return { status: 200, data: { output: { data: { followers: '2.5K' } } } }; } }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  const payload = await (await apiFetch('/api/followers', { method: 'POST', body: JSON.stringify({ authors: [{ platform: 'x', username: '@fixture_author' }] }) })).json();
  assert.equal(request.url, 'https://api.getanyapi.com/v1/run/twitter.profile');
  assert.deepEqual(request.data, { handle: 'fixture_author' });
  assert.deepEqual(payload.profiles.map(profile => ({ platform: profile.platform, followers: profile.followers })), [{ platform: 'x', followers: 2500 }]);
  assert.ok(preferences.get('rsignals:follower-cache:v1'));
});

test('Android external URLs use the desktop HTTPS host policy', () => {
  assert.equal(canOpenExternal('https://x.com/fixture/status/1'), true);
  assert.equal(canOpenExternal('https://notes.example.substack.com/p/post'), true);
  assert.equal(canOpenExternal('http://x.com/fixture/status/1'), false);
  assert.equal(canOpenExternal('https://example.invalid/redirect'), false);
});

test('Android background configuration and result handoff use durable Preferences', async () => {
  const preferences = new Map([['rsignals:background-results', JSON.stringify([{ id: 'background-result' }])]]);
  const plugins = {
    Preferences: {
      get: async ({ key }) => ({ value: preferences.get(key) || null }),
      set: async ({ key, value }) => preferences.set(key, value),
      remove: async ({ key }) => preferences.delete(key)
    }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  await syncBackgroundConfig({ platforms: ['x'], maxAgeHours: 3 });
  assert.deepEqual(JSON.parse(preferences.get('rsignals:background-config')), { platforms: ['x'], maxAgeHours: 3 });
  assert.deepEqual(await consumeBackgroundResults(), [{ id: 'background-result' }]);
  assert.equal(preferences.has('rsignals:background-results'), false);
});

test('Android notification actions open their linked opportunity externally', async () => {
  let notificationAction;
  const opened = [];
  const classes = [];
  const notificationLabel = {};
  const notificationDescription = {};
  const hint = {};
  const startupGroup = { classList: { add: value => classes.push(value) } };
  const notificationControl = { closest: () => ({ querySelector: () => notificationDescription }) };
  const startupControl = { closest: () => startupGroup };
  globalThis.document = {
    documentElement: { classList: { add: value => classes.push(value) } },
    querySelector: selector => ({
      '#credentialHint': hint,
      '#notificationsEnabled + span': notificationLabel,
      '#notificationsEnabled': notificationControl,
      '#startWithWindows': startupControl
    })[selector] || null
  };
  const plugins = {
    App: { addListener: async () => {} },
    Browser: { open: async options => opened.push(options) },
    LocalNotifications: { addListener: async (_event, callback) => { notificationAction = callback; } }
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: name => plugins[name] } };
  await configureNativePlatform();
  await notificationAction({ notification: { extra: { url: 'https://x.com/fixture/status/1' } } });
  assert.equal(hint.textContent, 'Stored with Android Keystore-backed encryption. RSignals never signs into social accounts.');
  assert.equal(notificationLabel.textContent, 'Show Android notifications');
  assert.equal(notificationDescription.textContent, 'Use Android notifications to call attention to strong matches.');
  assert.deepEqual(classes, ['native-android', 'hidden']);
  assert.deepEqual(opened, [{ url: 'https://x.com/fixture/status/1' }]);
});
