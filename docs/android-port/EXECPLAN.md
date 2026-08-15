# Purpose / Big Picture

RSignals will remain an Electron application on Windows while gaining an Android
application built with Capacitor. Both applications will use the existing web UI
and the same scanner rules: source request construction, normalization,
freshness, scoring, duplicate handling, and result filtering. Android users will
be able to configure a watchlist, save an AnyAPI key in secure storage, run scans,
review/save/hide results, open source links, receive native notifications, and
retain ordinary state after restarting the app.

## Current Architecture

As inspected on 2026-08-14:

- `main.js` launches an Electron window at a localhost server and owns the tray,
  Windows startup, toast notifications, and safe external-link policy.
- `preload.cjs` exposes Electron-only notification, external-link, startup, and
  tray-triggered scan IPC to the renderer.
- `server.js` serves `public/`, persists AnyAPI/seen/follower data through Node
  files, calls AnyAPI, runs scan orchestration, and contains parsers/normalizers.
- `codex-service.js` starts a native Codex subprocess and is desktop-only.
- `public/app.js` is a DOM-based UI using relative `/api/*` calls, localStorage
  for ordinary UI state, and in-WebView foreground scheduling.
- `public/scoring.js` is already browser-safe pure ESM.

## Target Architecture

```
Shared web UI (public/)
       |
Platform API boundary
       |
Shared scanner core
       |
Electron HTTP/files/IPC     Capacitor native HTTP/secure storage/plugins
```

The pure scanner core must not import Node, Electron, Android, a filesystem, or
an HTTP server. Electron will retain its server as a compatibility adapter.
Android will use Capacitor-native network, preferences, secure credential
storage, browser, notification, and lifecycle adapters. The native Codex service
will remain Electron-only; Android will show AI Assist as unavailable rather than
attempting unsupported ChatGPT authentication.

## Progress

- [x] 2026-08-14: Inspected the repository, Git state, architecture, tests, and hooks.
- [x] 2026-08-14: Baseline syntax checks passed with the available Node runtime.
- [x] 2026-08-14: Baseline Node tests passed (21/21) with direct `node --test`.
- [x] 2026-08-14: Confirmed `core.hooksPath=.githooks`.
- [x] Add a renderer platform API boundary and preserve Electron routes.
- [x] Add/configure Capacitor Android and package the existing UI.
- [x] Add Android secure credential, networking, notification, link, and lifecycle adapters.
- [x] Add Android-native WorkManager background execution with documented OS limits.
- [~] Extracted shared request/query/identity policy and characterization tests; source-specific parser unification remains future work because the native WorkManager adapter must stay small and OS-safe.
- [x] Build, install, launch, and validate the core Android scanner on the available Samsung device.
- [x] Extend regression coverage to 34 web/API tests plus 5 Android JVM tests, including Android persistence, live transport, shared request/identity policy, scan coordination, follower caching, notification routing, and background worker behavior.
- [ ] Complete time- or disruption-dependent physical scenarios: locked-screen execution, result-notification tap, network transitions, reboot, and extended Samsung battery-optimization observation.

## Surprises & Discoveries

- The checkout has user-owned untracked `AGENTS.md` and `Plans.md`; they are not
  to be overwritten. The requested plan is therefore under `docs/android-port/`.
- `npm test` currently fails only because this Codex shell does not put Node on
  `PATH`; direct `C:\Program Files\nodejs\node.exe --test` passed 21 tests.
- `npm audit` could not reach npm's audit service under the restricted network.
- Android SDK/JBR paths exist, but the sandbox denied executing `adb.exe`; device
  detection needs an approved host execution.
- Running bundled pnpm on this npm-lockfile checkout moved three dev packages
  into `node_modules/.ignored` before network denial; the exact packages were
  immediately restored. Future package work uses npm and `package-lock.json`.
- `public/index.html` uses root-relative static asset URLs. Capacitor asset paths
  must be made relative before packaging.
- Capacitor plugin proxies are thenable. A helper that returns one from an
  `async` function can stall while JavaScript attempts to await the proxy. The
  Android secure-storage accessor is intentionally synchronous and covered by
  a regression test.
- The Samsung registered and ran `BackgroundScanWorker`; JobScheduler reported
  the connected-network constraint and its OS-managed 15-minute next window.
- Direct narrow live checks through the installed Android adapter returned HTTP
  200 for X and LinkedIn with the configured AnyAPI credential. LinkedIn returned
  one fresh result; no credential or post content was logged.
- Watchlists, settings, saved/hidden records, and the native background config
  were verified through force-stop/relaunch. Synthetic save/hide test data was
  removed and confirmed absent after a final restart.

## Decision Log

- **2026-08-14 — retain Electron's localhost server initially.** It is a stable
  desktop compatibility layer. New shared code is extracted beneath it instead
  of replacing desktop routing in the Android milestone.
- **2026-08-14 — Android AI Assist is explicitly unavailable in the first port.**
  The existing implementation requires a native Codex binary, subprocesses, and
  desktop credential handling. No supported ChatGPT subscription flow exists in
  this application for Android.
- **2026-08-14 — use Capacitor-native transport and credential storage.**
  Android must not rely on WebView CORS or persist AnyAPI credentials in
  `localStorage`.
- **2026-08-14 — share notification policy as pure browser-safe code.** Quiet
  hours, follower gating, score gating, and ordering are exercised by Node tests
  while the renderer retains platform-specific delivery adapters.
- **2026-08-14 — share scanner request/identity policy and coordinate scans natively.**
  `public/shared/scanner-policy.js` now drives desktop and foreground-Android
  source query construction, request bodies, and canonical post keys. A small
  Android lease serializes WorkManager and WebView scans; native code remains
  only for OS background execution and Android persistence.

## Milestones

### Milestone 0 — Baseline

Completed as recorded above. Preserve all existing Electron behavior.

### Milestone 1 — Characterization and shared scanner core

Add tests for scan request limits, post identity, freshness, duplicate and seen
decisions. Extract only pure helpers first; retain server exports as compatibility
re-exports where needed. Acceptance: existing tests plus new tests pass.

### Milestone 2 — Platform API boundary

Move renderer API calls behind a small injected API. The desktop implementation
continues calling existing routes; the Capacitor implementation supplies direct
native behavior. Acceptance: Electron still runs without renderer regressions.

### Milestone 3 — Minimal Capacitor Android boot

Add Capacitor, an Android project, and stable scripts. Use `public/` as the web
directory, fix static asset paths, and build a debug APK. Acceptance: Android
activity launches and renders the existing UI.

### Milestone 4 — Android scanning and persistence

Implement secure AnyAPI credential storage, native HTTP, durable preferences,
manual scan orchestration, local seen history, and a user-facing unavailable AI
state. Acceptance: configured live/manual scan works without localhost.

### Milestone 5 — Native mobile behavior

Use Capacitor for Android external links and local notifications; make safe-area,
back-button, keyboard, and touch-target fixes only where the real phone layout
needs them. Acceptance: configured notification/link behavior works.

### Milestone 6 — Background scanning spike and production decision

Validate a platform-supported background mechanism before claiming background
scanning. Document actual Samsung/Android scheduling limitations, duplicate work
protection, and failure behavior.

### Milestone 7 — Release validation

Run all available JavaScript, Electron, Gradle, and device checks; inspect the
diff and secret scan; update `TESTING.md` and project documentation.

## Concrete Commands

Verified from this repository on 2026-08-14:

```powershell
& 'C:\Program Files\nodejs\node.exe' --check main.js
& 'C:\Program Files\nodejs\node.exe' --check server.js
& 'C:\Program Files\nodejs\node.exe' --check public/app.js
& 'C:\Program Files\nodejs\node.exe' --test
```

The direct suite currently passes 34 tests. The normal `npm test` command is
retained but needs Node on `PATH` in this Codex shell. The Android build and
unit-test commands in `docs/android-port/README.md` have run successfully with
Java 21, and the resulting debug APK has been installed on the Samsung.

## Validation and Acceptance

Each shared-core change must retain fixture parser behavior and desktop routes.
Android validation includes a debug build, launch, live/manual scan, preference
persistence, secure credential use, external links, notification
eligibility/deduplication, lifecycle behavior, and the Samsung matrix in
`TESTING.md`. Demo mode is regression-covered; physical demo validation would
require clearing the user credential and remains intentionally pending.

## Rollback / Compatibility

Electron's server, preload bridge, Windows notifications, tray, startup, and
Codex service remain separate platform adapters. The Android code must not be
required for Electron startup. New storage keys are additive, and Android never
imports desktop credential/cache files.
