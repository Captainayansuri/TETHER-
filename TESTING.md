# Application test suite

Run the complete desktop, mobile web receiver, Android unit, and Android
instrumentation suites from the workspace root:

```powershell
npm test
```

The command runs the desktop Node test suite first. That suite includes the
browser receiver integration harness, which drives camera permission outcomes,
camera lifecycle events, image validation, chunk transfer, save acknowledgement,
and reconnect against the actual receiver script. It then runs Android local
unit tests and connected-device instrumentation tests. The Android step needs
a compatible Gradle installation and a running emulator or attached device.
If the project Gradle wrapper is present, the runner uses it automatically.

The desktop tests cover pairing authentication, real WebSocket handshakes,
file signatures and sizes, traversal attempts, persistence/recovery,
idempotent duplicate capture handling, multi-client transfers, backpressure,
thumbnail/gallery delivery, shutdown and reconnect policies. Android unit tests
cover durable queue limits/recovery, capture ID uniqueness, persisted
acknowledgement rules, reconnect backoff, and network-change behavior.
Instrumentation tests launch the real camera activity with the camera
permission granted and exercise stop/resume/recreation on Android.

For Android release acceptance (camera hardware, permission denial dialogs,
and force-stop recovery), follow the device checklist in
`android-app/RELEASE.md`; that acceptance is separate from the automated
emulator suite.
