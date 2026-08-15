# Android development

RSignals for Android is a Capacitor 8 app in `android/`. It reuses the existing
HTML/CSS/JavaScript UI; the Android build copies `public/` plus Capacitor's
runtime into the ignored `www/` directory before syncing.

## Prerequisites

- Node.js 22 or newer (the Capacitor CLI currently requires Node 22+).
- Android Studio with Android SDK Platform 36 and Build Tools installed.
- A Java 21 JDK configured as the Gradle JDK. Java 25 from the current Android
  Studio JBR is not compatible with this repository's Gradle/Groovy setup.

Open `android/` as the Android Studio project. If Gradle does not find the SDK,
Android Studio creates an ignored `android/local.properties` containing the
machine-local `sdk.dir` path. Do not commit that file.

## Commands

From the repository root in a normal shell where Node is on `PATH`:

```powershell
npm ci
npm run build:web
npm run android:sync
npm run android:open
npm run android:build
npm run android:test
```

The current Codex shell needs explicit paths. The commands below have been used
to run JavaScript validation and Capacitor sync here:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test
& 'C:\Program Files\nodejs\node.exe' scripts\build-web.mjs
& 'C:\Program Files\nodejs\node.exe' node_modules\@capacitor\cli\bin\capacitor sync android
```

For a command-line Gradle build, set `JAVA_HOME` to a Java 21 installation and
ensure `android/local.properties` points to the local Android SDK:

```powershell
cd android
gradlew.bat assembleDebug
gradlew.bat testDebugUnitTest
```

The expected debug APK path is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Android platform behavior

- **UI and ordinary state:** existing UI state (watchlists, settings, saved and
  hidden posts) remains in WebView `localStorage`; Capacitor Preferences stores
  Android scanner seen-history durably.
- **AnyAPI key:** Android uses `@aparajita/capacitor-secure-storage`, which
  encrypts values with a key held by Android Keystore before storing them in app
  preferences. The key is not written to web `localStorage` or source files.
  The bridge calls the plugin's native methods directly so the Electron-served
  web UI does not need to bundle the plugin's JavaScript wrapper.
- **Networking:** scans use Capacitor HTTP so live AnyAPI calls do not rely on
  a localhost server or browser CORS behavior.
- **Links and notifications:** Capacitor Browser opens only approved HTTPS
  source/OpenAI hosts outside the app; Capacitor Local Notifications requests
  permission before delivery. Only fresh, score-qualified results enter the
  notification decision path.
- **AI Assist:** Android supports on-demand analysis, reply drafts, and feed
  screening through a user-supplied OpenAI API key stored with Android
  Keystore-backed secure storage. ChatGPT-subscription sign-in and the desktop
  Codex executable remain Electron-only. Settings provides separate model
  choices for summaries/screening and suggested replies; selections persist in
  Android Preferences and default to GPT-4o mini.
- **Foreground scheduling:** the configurable foreground interval runs while
  the Android app/WebView is active. A native scan lease prevents it from
  overlapping a WorkManager scan.
- **Background scheduling:** a native WorkManager worker is registered with a
  network constraint and a 15-minute minimum interval. It reads the same
  Android Keystore-protected AnyAPI credential, honors quiet hours and the
  notification/follower/score thresholds, shares a durable follower cache and
  seen history with the foreground adapter, and writes results for the UI to
  show on next launch. Individual provider failures do not stop other jobs;
  all-transient failures are retried. Android/OEM battery policy can defer
  periodic work, so this is deliberately not an exact schedule.

## Samsung / ADB workflow

With an authorized device connected:

```powershell
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.signal.scanner 1
adb logcat -d -v time | Select-String 'RSignals|Capacitor|AndroidRuntime'
```

Complete the matrix in `TESTING.md`, particularly the normal Samsung battery
optimization background test, before treating background behavior as supported.
