# Android release

The release variant targets Android 16 (API 36), uses application ID
`com.imagetether.tethercam`, enables R8 and resource shrinking, and is
configured to build both an APK and a Play-ready Android App Bundle (AAB).
Version defaults are `1` / `1.0.0`; set `ANDROID_VERSION_CODE` and
`ANDROID_VERSION_NAME` for each release (or pass `-PVERSION_CODE=...`
and `-PVERSION_NAME=...`). Increment the code for every published update.

## Signing

Do not commit a signing key, password, `local.properties`, or a populated
`gradle.properties`. Supply the production keystore location and credentials
through the build environment:

```powershell
$env:ANDROID_RELEASE_STORE_FILE = 'C:\secure\tethercam-release.jks'
$env:ANDROID_RELEASE_STORE_PASSWORD = '<from secure CI secret storage>'
$env:ANDROID_RELEASE_KEY_ALIAS = '<release alias>'
$env:ANDROID_RELEASE_KEY_PASSWORD = '<from secure CI secret storage>'
```

Keep a protected backup of the upload key. Google Play App Signing is
recommended: enroll the app with the AAB and protect the upload key separately.
Release tasks fail if signing is missing. `-PallowUnsignedRelease=true` is only
for local packaging checks; never distribute such artifacts.

Build both outputs with an installed compatible Gradle:

```powershell
gradle :app:assembleRelease :app:bundleRelease
```

Outputs are under `app/build/outputs/apk/release/` and
`app/build/outputs/bundle/release/`. Verify signing with `apksigner verify
--verbose --print-certs app\build\outputs\apk\release\app-release.apk` and
`jarsigner -verify -verbose -certs app\build\outputs\bundle\release\app-release.aab`.

The app needs camera capture, Internet, active-network monitoring, and haptic
feedback permissions. It does not request storage, location, microphone, or
contacts access. Cleartext is allowed in the explicit network security config
because the companion desktop server currently accepts WebSocket connections
over `ws://` at a user-entered LAN address. The pairing token is generated at
runtime and the app contains no embedded pairing credential or signing secret.
All `android.util.Log` calls are removed from release bytecode by R8. R8 keeps
line metadata for crash retracing; mapping files are emitted with each build
and must be retained privately alongside the exact release.

`PendingImageStore` journals captured images to app-private storage before
transfer. Lifecycle teardown cancels networking and camera workers while
pending uploads remain on disk for recovery at the next launch. The splash
screen uses the TetherCam vector mark and returns to the normal camera theme.

## Release acceptance

On a clean physical Android 7.0+ device, install the signed APK (or install
the generated universal APK from the AAB), grant camera permission, pair with
the desktop, capture and transfer an image, background/foreground the app,
force-stop and relaunch with an interrupted transfer, and confirm the queued
image retries safely. Check the app icon and launch splash screen. Verify no
release `Logcat` output from the `TetherCam` tag, inspect the merged manifest
for only the listed permissions, and retain the R8 mapping file for the build.
