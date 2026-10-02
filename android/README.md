# Android client

This folder now contains the first Android app skeleton for the Lænsmann Camera client.

Current focus:

- camera permission flow
- local preview using CameraX
- connection to the local backend
- foundation for future reconnect logic and foreground service

## Project structure

- `app/` – Android application module
- `build.gradle.kts` – project plugins
- `settings.gradle.kts` – Gradle module setup

## Next steps

1. Open the `android/` folder in Android Studio.
2. Sync Gradle.
3. Connect the app to the Node.js signaling server on port `3001`.
4. Add a foreground service and reconnect loop before production use.
