# RSignals validation record

## Baseline — 2026-08-14

| Check | Outcome |
| --- | --- |
| `node --check main.js` | Passed using `C:\Program Files\nodejs\node.exe` |
| `node --check server.js` | Passed using `C:\Program Files\nodejs\node.exe` |
| `node --check public/app.js` | Passed using `C:\Program Files\nodejs\node.exe` |
| Direct `node --test` | Passed: 34 tests, 0 failures |
| `npm test` | Blocked in this Codex shell: Node is not on `PATH` for npm's child process |
| `npm audit --audit-level=high` | Passed threshold: no high findings. npm reports three moderate `uuid` findings through Capacitor CLI; its offered remediation is a forced incompatible CLI change and was not applied. |
| Git hooks | `.githooks` is configured through local `core.hooksPath` |
| Android SDK / JBR paths | Present |
| `adb devices` | Passed: Samsung `RZCXA130ZYT` connected and used for install/launch validation |
| Electron GUI startup | Passed (user validation) | User confirmed Electron launched successfully; Codex host had stalled only on a missing first-time runtime download. |

## Android implementation checks - 2026-08-14

| Check | Outcome |
| --- | --- |
| Web/API regression suite | Passed: 34 tests, 0 failures. Covers Android secure-key save/status, shared source policy and canonical identity, native scan-lease deferral, profile lookup/cache, safe external links, notification policy, and action routing. |
| Android JVM regression suite | Passed: 5 tests, 0 failures (`AndroidConfigTest` plus 4 focused `BackgroundScanWorkerTest` checks); protects launch configuration, canonical URL identities (including LinkedIn activity URLs), platform-specific follower filtering, and transient-provider retry classification. |
| JavaScript syntax (`public/app.js`, `public/platform-api.js`) | Passed |
| WorkManager worker | Passed: compiled with the debug build; Samsung JobScheduler confirmed registration and an initial successful run |
| Android debug APK | Passed: combined `testDebugUnitTest` and `assembleDebug` with Java 21; final 8,133,199-byte APK installed on Samsung |
| Android JVM tests | Passed: `testDebugUnitTest` |
| Samsung launch smoke test | Passed: final APK installed; `com.signal.scanner/.MainActivity` became the top resumed activity, rendered 16 live/background results after unlock, and had no RSignals AndroidRuntime crash |
| Samsung WorkManager registration | Passed: network-constrained unique periodic work is registered; Android/OEM timing is not exact |

## Samsung Android validation matrix

Run this matrix against the debug APK without disabling battery optimization
before the first background observation. Record device model, Android version,
build, date, observations, and relevant sanitized logcat evidence.

| Scenario | Result | Notes |
| --- | --- | --- |
| First launch / WebView render | Passed | 2026-08-14: `MainActivity` was top resumed; feed, Saved, Watchlists, and Settings were reviewed on the connected Samsung. The final APK loaded the packaged shared policy module and rendered 16 results after unlock. |
| Responsive controls / menus | Passed | 2026-08-15: Capacitor safe-area variables now keep the compact top rail below Samsung's status-bar touch region; Feed, Watchlists, Saved, and Settings all opened through the corrected controls. Watchlists source checkboxes, key controls, notification action, quiet-hours fields, and day checkboxes stayed within their cards in landscape; the portrait feed also rendered without clipping. Header density, icon-only navigation, and skim-first card design remain planned UX work. |
| Demo scan | Pending | |
| Live AnyAPI scan with user key | Passed | Key persisted through force-stop/restart; narrow Android adapter checks returned HTTP 200 for both enabled sources. X returned no fresh post for its selected topic; LinkedIn returned one fresh result. Later on-device scans displayed 15 and then 16 cards. Neither narrow request reported a provider failure. Credentials were not inspected. |
| Watchlist persistence | Passed | Android WebView local storage contains persisted source selections and per-source watchlist keys after app restart. Values were not inspected. |
| Settings persistence | Passed | Saved unchanged defaults, force-stopped/reopened the app, and verified scan limit/interval, notification score/state, quiet-hours state, and durable settings keys rehydrated. |
| Save/hide persistence | Passed | With both stores initially empty, a clearly synthetic saved post and hidden identity survived a force-stop/relaunch. Both test entries were then removed, committed, and confirmed absent after a final restart. |
| Background then foreground | Passed (worker execution) | Samsung JobScheduler recorded `BackgroundScanWorker` starting and finishing successfully after the final install. The foreground UI subsequently showed 11 new background results ready. The WebView and worker use one native lease, so a foreground scan defers while native work owns it. |
| Screen locked | Partially checked | With the screen locked, `MainActivity` remained the top resumed activity and the worker job remained registered with no crash. In a 2026-08-15 scheduled-window observation, Samsung entered Doze and withdrew the worker's connected-network constraint, so no valid locked-screen network scan could run. A naturally scheduled locked-screen execution while Android reports connected networking remains pending. |
| Notification delivery and tap | Passed (delivery/callback) | User received the in-app test notification on the Samsung. A labeled action-test notification was posted with an Android content intent; the adapter test verifies its action callback opens the URL through Capacitor Browser. Physical shade tapping remains pending because this Samsung's current ADB UI channel would not expose a safe notification tap target. |
| External link opens | Passed (adapter) | The Capacitor Browser adapter was physically exercised earlier. The final allowlist now only opens HTTPS source/OpenAI hosts; its behavior is covered by Node regression tests. |
| Wi-Fi loss/recovery | Pending | |
| Wi-Fi to mobile-data transition | Pending | |
| Process kill/reopen | Passed | 2026-08-15: `adb shell am kill com.signal.scanner` simulated ordinary Android process reclamation. The app relaunched to `MainActivity` without an `AndroidRuntime` or fatal exception in the captured startup log window. |
| Force-stop/reopen | Passed (key persistence) | AnyAPI key remained configured after clean force-stop/relaunch on Samsung. |
| Device reboot | Pending | |
| Background scan under Samsung optimization | Partially checked | JobScheduler recorded a successful network-constrained worker run with the app in Android's active bucket. Long-running observation with normal Samsung battery optimization remains pending. |
