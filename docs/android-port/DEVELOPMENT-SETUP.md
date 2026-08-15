# RSignals Development Setup

This repository is developed on Windows with PowerShell, Android Studio, Capacitor, and a connected Samsung device. This guide records the setup that is known to work so a future session can continue without rediscovering it.

## Repository and shells

Open the repository in:

```text
C:\Users\vsaro\OneDrive\Documents\ChatGPT\Android RSignal
```

Use PowerShell from that directory. The project uses the existing HTML/CSS/JavaScript UI for both Electron and Capacitor Android; do not start a second frontend.

The untracked `AGENTS.md` and `Plans.md` files are local instruction files. Preserve them and do not include them in commits unless explicitly requested.

## Android Studio and Java

Set Android Studio's Gradle JDK to:

```text
C:\Users\vsaro\AppData\Local\RSignals-Android\jdk-21\jdk-21.0.12+8
```

For a PowerShell build outside Android Studio, set the same JDK for that terminal:

```powershell
$env:JAVA_HOME = 'C:\Users\vsaro\AppData\Local\RSignals-Android\jdk-21\jdk-21.0.12+8'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version
```

The expected runtime is Temurin/OpenJDK 21. Do not commit a JDK, Gradle cache, SDK, keystore, or credentials.

## JavaScript checks

From the repository root:

```powershell
node --check main.js
node --check server.js
node --check public/app.js
npm.cmd test
```

The current regression suite has 34 tests. `npm.cmd test` is the authoritative JavaScript test command.

## Capacitor and Gradle

The verified package scripts are:

```powershell
npm.cmd run build:web
npm.cmd run android:sync
npm.cmd run android:build
npm.cmd run android:test
npm.cmd run android:open
```

`android:build` produces `android\app\build\outputs\apk\debug\app-debug.apk`. If Gradle reports that `JAVA_HOME` is missing, set it as shown above and rerun the command in the same PowerShell session.

## Device workflow

The Samsung device is validated through the Android SDK platform tools. First verify that the device is authorized:

```powershell
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' devices
```

Install and relaunch the debug build:

```powershell
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' install -r 'C:\Users\vsaro\OneDrive\Documents\ChatGPT\Android RSignal\android\app\build\outputs\apk\debug\app-debug.apk'
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' shell am force-stop com.signal.scanner
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' shell monkey -p com.signal.scanner 1
```

Capture a screen for UI review:

```powershell
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' shell screencap -p /sdcard/rsignals-ui.png
& 'C:\Users\vsaro\AppData\Local\Android\Sdk\platform-tools\adb.exe' pull /sdcard/rsignals-ui.png "$env:TEMP\rsignals-ui.png"
```

The app id is `com.signal.scanner`. Device testing is additive; automated builds and tests must not depend on the phone being connected.

## Credentials and data

Never put AnyAPI, OpenAI, OAuth, or device credentials in source control. Configure the AnyAPI key from the app's Settings screen. Android stores the sensitive key through the secure-storage adapter; ordinary settings, watchlists, saved/hidden posts, and seen identities use durable app preferences.

## Git workflow

Inspect scope before staging:

```powershell
git status -sb
git diff --stat
```

Stage explicit files rather than using `git add -A` when local instruction files or generated artifacts are present. The configured author for this repository is `Vlad Sarov <vsarov@gmail.com>`. After tests and the Android build pass, commit intentional source/documentation changes, push the current branch, and open a draft pull request when publication is requested.

## Current architecture reminder

Electron continues to use `main.js`, `preload.cjs`, and the Node API in `server.js`. Android uses the shared `public/` UI with Capacitor adapters for HTTP, secure storage, preferences, notifications, external links, and lifecycle behavior. The desktop Codex subprocess in `codex-service.js` is not bundled into Android; Android AI Assist uses the isolated user-supplied OpenAI API-key adapter instead of ChatGPT-subscription authentication. Android Settings persists separate model selections for summary/screening and reply generation through Preferences.
