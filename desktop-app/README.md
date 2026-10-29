# TETHER desktop app

TETHER connects the desktop dashboard with the mobile browser receiver and
native Android client over a local network. The desktop window, dashboard,
launcher, and Windows installer use the TETHER name. Existing application IDs
and connection routes remain unchanged so current pairing and stored data keep
their compatibility.

For a local development launch on Windows, run these commands from
`desktop-app`:

```powershell
npm run build
npm start
```

`npm start` builds the dashboard and launches Electron through
`launch-electron.js`, which removes an inherited `ELECTRON_RUN_AS_NODE` override
that would otherwise run the Electron main process under plain Node.js.

## Windows distribution

The Windows x64 release is built with Electron Builder and NSIS. The package
version in `package.json` is the installer version; increment it using
`major.minor.patch` for each release. Build the production dashboard and the
per-user installer with:

```powershell
npm ci
npm run release:win
```

The installer is written to `release/`. Electron Builder places the main
process, preload, local server modules, mobile web assets, dashboard build,
runtime dependencies, and application icon in the installed application.
Production starts the dashboard from the packaged `dist/index.html`; it never
contacts Vite or reads source files outside the installation. Captures and
other writable application data live under Electron's per-user `userData`
directory, outside the install folder. Uninstall removes the application and
shortcuts while preserving captures and settings.

Updates use versioned installer replacement: distribute the new signed or
unsigned NSIS installer and have users close the app and run it. NSIS upgrades
the existing per-user installation in place and keeps `userData`; there is no
in-app updater or update feed configured. Configure Windows code signing in
the release environment before publishing installers to reduce SmartScreen
warnings and ensure users can verify the publisher. The current build emits
unsigned installers unless signing credentials are supplied and signing is
enabled in the builder configuration.

Before publishing, build with `npm run release:win`, install the generated
installer under a standard user account on a clean Windows x64 machine, launch
it with the development checkout unavailable, pair a mobile client, save a
capture, uninstall, and confirm that the capture remains in the user data
directory. Installer generation alone does not replace this clean-machine
acceptance check.

The desktop app creates a fresh 256-bit pairing token each time it starts. The
default lifetime is 30 minutes. Set `TETHER_PAIRING_TOKEN_TTL_MS` to an integer
from 1 to 2,592,000,000 milliseconds (30 days) to change it, for example:

```powershell
$env:TETHER_PAIRING_TOKEN_TTL_MS = "3600000"
npm start
```

The dashboard QR code carries the token in the URL fragment for the browser
receiver. The Android app requires the displayed token to be entered manually.
The token is not sent as a WebSocket message: clients prove possession using an
HMAC-SHA-256 challenge response. Unauthenticated sockets are closed and cannot
send images or commands.

## Application configuration

Desktop/server configuration is resolved once at startup by `runtime-config.js`.
Set `NODE_ENV` to `development`, `test`, or `production`; packaged Electron
builds always use the production profile. Configuration values are validated
before storage or server startup. An invalid value stops startup instead of
silently falling back. Environment overrides use the `TETHER_` prefix:

| Setting | Environment override | Development / production default | Test default |
| --- | --- | ---: | ---: |
| HTTPS and WebSocket server port | `TETHER_PORT` | 8080 | 0 (ephemeral) |
| Vite dashboard development port | `TETHER_DASHBOARD_DEV_PORT` | 5173 | 5173 |
| Maximum image size | `TETHER_MAX_IMAGE_BYTES` | 32 MiB | 32 MiB |
| Pairing token lifetime | `TETHER_PAIRING_TOKEN_TTL_MS` | 30 minutes | 1 minute |
| Waiting upload queue size | `TETHER_MAX_QUEUED_UPLOADS` | 32 | 2 |
| Capture directory | `TETHER_CAPTURE_DIR` | `<userData>/tether_captures` in production; mode-specific directory otherwise | `<userData>/tether_captures-test` |
| Logging threshold | `TETHER_LOG_LEVEL` | `DEBUG` / `INFO` | `SILENT` |
| Thumbnail cache size | `TETHER_THUMBNAIL_CACHE_MAX_BYTES` | 256 MiB | 1 MiB |
| Thumbnail cache age | `TETHER_THUMBNAIL_CACHE_MAX_AGE_MS` | 30 days | 1 minute |
| Thumbnail dimensions | `TETHER_THUMBNAIL_WIDTH`, `TETHER_THUMBNAIL_HEIGHT` | 480 × 320 | 480 × 320 |
| WebSocket authentication timeout | `TETHER_CONNECTION_TIMEOUT_MS` | 5 seconds | 1 second |
| Graceful shutdown timeout | `TETHER_SHUTDOWN_TIMEOUT_MS` | 30 seconds | 1 second |

Additional server controls are `TETHER_MAX_CONCURRENT_UPLOADS` (4),
`TETHER_HEARTBEAT_INTERVAL_MS` (30 seconds),
`TETHER_STALE_CONNECTION_TIMEOUT_MS` (2 minutes),
`TETHER_MAX_CLIENT_CONNECTIONS` (32),
`TETHER_RECONNECT_MAX_INTERVAL_MS` (30 seconds), and
`TETHER_PORT_FALLBACK_ATTEMPTS` (20). `TETHER_SHUTDOWN_TIMEOUT_MS` accepts
1,000–300,000 milliseconds and bounds transfer draining and graceful peer
closure before incomplete transfers are abandoned safely. The test profile uses lower resource
limits and no port fallback. In development and production, if the configured
port is busy the server tries only the configured number of following ports.

For example, PowerShell can set process-scoped overrides before starting the
app:

```powershell
$env:NODE_ENV = "development"
$env:TETHER_PORT = "8080"
$env:TETHER_MAX_IMAGE_BYTES = "67108864"
$env:TETHER_LOG_LEVEL = "DEBUG"
npm start
```

Configuration is kept in the Electron main process and is not returned as a
whole object over IPC. The dashboard receives only values needed by its UI;
the pairing token is included because the pairing panel must display it for
Android setup and its QR code is needed by the browser receiver. The redundant
token-bearing mobile URL and server-only secrets are not sent to the renderer.

## Structured production logs

Desktop/server logs are one JSON object per line with an ISO timestamp, an
uppercase `DEBUG`, `INFO`, `WARN`, or `ERROR` level, a stable event name, and
only explicitly permitted diagnostic fields. Production defaults to `INFO`;
development defaults to `DEBUG`. Set `TETHER_LOG_LEVEL` to one of those four
levels to change the threshold. `SILENT` is available for the test profile.
Events cover startup/shutdown, server and WebSocket lifecycle, authentication
outcomes, queue and transfer progress, image validation, persistence and
acknowledgement, and failures. Transfer events can include the generated
capture ID, byte counts, format, state, duration, and safe error codes.

The logger drops unapproved fields. It never logs image bytes/contents,
pairing or capture-access tokens, authentication proofs, passwords, keys,
filesystem paths, raw URLs, IP addresses, raw user agents, or device names.
Authentication results record only accepted/rejected outcomes and generic
reason codes; connection open/close events help correlate client retries.

The maximum image payload is 32 MiB by default. Set
`TETHER_MAX_IMAGE_BYTES` to a positive integer from 1 byte to 128 MiB to change
the limit. The server advertises the configured limit to paired Android and
mobile web clients. JPEG, PNG, and WebP are accepted based on file signatures,
not MIME headers or extensions.

Each image transfer includes a client-generated capture UUID and SHA-256
checksum. The desktop acknowledges the matching capture only after verifying
the image and flushing and verifying a temporary file. The desktop installs the
final filename with a same-directory atomic rename after the shared upload queue
reserves the capture ID. Clients generate random UUID capture IDs, retain
unacknowledged transfers in memory, and retry
with the same ID; the desktop recognizes an identical saved capture and returns
its existing result without creating a duplicate. Reusing an ID for different
image contents is rejected, and a rejected or incomplete upload does not reserve
the ID.

Payloads are sent in acknowledged 1 MiB chunks, so Android's WebSocket send
queue remains bounded and an interrupted upload can discard its partial
temporary file before a same-ID retry.

## Pairing an Android phone

The local server serves the mobile receiver over HTTPS and accepts image
transfers over WSS. On Windows, TETHER creates a per-user local certificate
authority and a server certificate for the current local IPv4 interfaces. The
CA key is non-exportable and stored in the Windows Current User certificate
store with an ACL limited to that Windows account and SYSTEM. The per-user
`userData\tls` directory retains its inherited Windows AppData permissions; it
contains only the public CA export, CA thumbprint/version metadata, and a
short-lived password-protected server PFX that is removed after it is loaded.
The dashboard shows the current HTTPS
`IP:port`, CA SHA-256 fingerprint, server certificate expiry and SAN values,
and Android SPKI pin. The QR code uses the current LAN address and includes the
short-lived browser pairing token in its URL fragment.

For Android Chrome, install the exported CA before opening the QR code:

1. On the desktop dashboard, choose **Export Trust Certificate** and save the
   `.cer` file.
2. Transfer that certificate file to the phone. In Android Settings, search
   for **Install a certificate** or **CA certificate**; menu names vary by
   Android version and device manufacturer. Select the **CA certificate**
   option, not a Wi-Fi certificate option.
3. Compare the certificate's SHA-256 fingerprint with the value shown in the
   TETHER desktop window through a trusted channel (for example, read the
   fingerprint directly from that screen while viewing the phone). Do not rely
   only on downloading the certificate from the same LAN. Android warns that
   a user CA can authorize inspection of HTTPS traffic on the phone. Install
   only this TETHER CA on a device you control, and remove it when you stop
   using TETHER.
4. Open the current dashboard QR code in Chrome. Do not bypass a certificate
   warning. The dashboard's certificate diagnostics show the expected SAN IP
   values and expiry dates; the address opened in Chrome must match an IP SAN.
   If Chrome reports an authority error, check that Android imported the CA as
   a user CA and compare the CA fingerprint again.

Chrome trust is local to the phone and cannot be confirmed remotely by TETHER.
The desktop dashboard reports whether its certificate is present, unexpired,
and matches the advertised URL, then explains the corresponding browser error:

- `NET::ERR_CERT_AUTHORITY_INVALID`: stop; verify the fingerprint and confirm
  Android installed the certificate as a CA credential.
- `NET::ERR_CERT_COMMON_NAME_INVALID`: use the current QR/address and check
  that its IP is listed in the dashboard SAN details. Refresh the pairing card
  after the PC changes networks so TETHER can renew the leaf certificate.
- A certificate expiry or TLS setup diagnostic: restart TETHER and check the
  desktop startup log and Windows clock; do not bypass the browser warning.
- A connection timeout after Chrome accepts the certificate: check same-Wi-Fi
  reachability, guest-network isolation, and a Windows Firewall inbound rule
  for TETHER on the Private profile, current TCP port, and `LocalSubnet` only.
  Check the active policy with `netsh advfirewall show currentprofile`. If it
  reports `LocalFirewallRules N/A (GPO-store only)`, local firewall exceptions
  are not merged; ask the administrator to add the scoped rule through policy.
  Do not disable the firewall or open TETHER on the Public profile.

For the native Android app, install the same CA certificate, then enter the
current `IP:port`, pairing token, and Android certificate pin shown on the
dashboard. The app requires WSS and checks the pin; cleartext traffic is
disabled. The Android network security configuration trusts user-added CAs for
this app, while OkHttp's certificate pin restricts the TETHER WebSocket
connection.

The server listens on `0.0.0.0` so another device on the LAN can reach it.
When Windows Firewall asks, allow TETHER/Electron on **Private networks**. If
the prompt was dismissed, open Windows Security → Firewall & network protection
→ Allow an app through firewall and enable the TETHER app for the Private
profile only. Keep the phone and desktop on the same Wi-Fi/LAN and check that
the dashboard's current address belongs to that network; guest Wi-Fi client
isolation or VPN routing can prevent devices from reaching one another.

The certificate authority is reused across ordinary desktop restarts; the
server certificate is reissued for the current LAN address and refreshed before
expiry without closing active WebSocket sessions. A one-time CA migration
applies non-exportable key storage and a restricted Windows key ACL; it changes
the CA fingerprint, so remove the old TETHER user CA from Android and install
the newly fingerprint-verified certificate. Later ordinary leaf renewals do
not require reinstalling the CA or changing the native Android CA pin. Pairing
tokens remain temporary and must be refreshed when expired or after a desktop
restart.

### Resetting TETHER certificate trust

To revoke this desktop's trust on a phone, remove the TETHER entry under
Android **User credentials** (the exact Settings labels vary by manufacturer).
On Windows, close TETHER, open `certmgr.msc`, and remove **TETHER Local Root CA**
from **Current User > Personal > Certificates**. In TETHER's per-user
`userData\tls` directory, remove `root-thumbprint.txt` and
`root-security-version.txt`, then restart TETHER. It will create a new CA and
show a new fingerprint; transfer the fresh public `.cer` and compare its
fingerprint through a trusted channel before installing it. If an old CA entry
is still present on Android, remove it before trusting the replacement. This
reset invalidates old server certificates and may require re-pairing clients.

## Graceful shutdown

Electron quit, non-macOS last-window close, `SIGINT`, and `SIGTERM` share one
shutdown path. It stops accepting new HTTPS/WebSocket connections, sends
connected clients a `server_shutdown` notice, stops new upload-queue admission,
and lets admitted transfers finish within `TETHER_SHUTDOWN_TIMEOUT_MS`.
Outstanding transfer receivers then finish safe writes and remove incomplete
temporary uploads; gallery publication work is awaited before WebSockets and
the HTTP listener are closed. If peers or writes do not drain before the
timeout, unfinished temporary files are cleaned and remaining sockets are
forcibly closed so Electron can release the server port and exit. Persisted
captures and their metadata are flushed atomically before their ACK is sent.

## Electron renderer security

The desktop window uses context isolation, a sandboxed renderer, disabled
Node integration, and Chromium web security. The preload exposes a small set
of explicit event and image/server actions rather than raw IPC. IPC calls are
restricted to the trusted dashboard and validate their arguments. Navigation
and redirects are limited to the dashboard, popups are denied (safe HTTP(S)
links open in the system browser), embedded webviews are blocked, and
permission requests are denied. DevTools and the Vite development origin are
enabled only when running unpackaged with `NODE_ENV=development`.

## WebSocket reconnect behavior

The Android and mobile web clients use bounded exponential backoff with jitter,
starting at one second. The default maximum retry interval is 30 seconds; set
`TETHER_RECONNECT_MAX_INTERVAL_MS` to an integer from 1,000 to 600,000
milliseconds to change it. A successful authenticated connection resets the
backoff. The browser receiver keeps its current pending transfer in memory and
retries it using the same capture ID. Android writes pending camera JPEGs to
private app storage and preserves the queue over screen rotation and process
restart. The desktop pings WebSocket peers and terminates stale
connections so clients can detect network and server failures.

The mobile browser receiver reports camera permission denial, missing or busy
cameras, unsupported live-camera APIs, and insecure-context restrictions. It
can switch between front and rear cameras where the browser exposes those
modes, and falls back to the device camera/photo picker when live preview is
unavailable. Camera tracks are stopped when the page is hidden or left and
reacquired on return when permission allows. The receiver validates image
signatures and the advertised size limit before reading the full image for its
checksum. Only one image is prepared or transferred at a time; chunk
acknowledgements update visible progress, while network failure retains the
same capture ID for a safe retry. Browser transfers are held in page memory
only, so closing or reloading the tab can discard an unacknowledged image.

Android networking follows the Activity lifecycle: it closes the socket and
unregisters network monitoring when the app is backgrounded or the phone is
locked, while preserving queued captures in private storage. Returning to the
foreground registers monitoring again and reconnects to the current default
network. Android also reconnects when Wi-Fi/cellular changes or the default
network's addresses/routes change, and only one reconnect attempt or timer is
active at a time. OkHttp sends a ping every 20 seconds to detect half-open
connections. The app does not keep a WebSocket alive in the background; pending
photos resume when it returns to the foreground.

## Android camera and offline queue

CameraX binds to the Activity lifecycle and is initialized only while the
Activity is started and camera permission is granted. Denied permission,
missing/unavailable camera hardware, and CameraX initialization/binding errors
are reported without crashing or terminating the app. The shutter rejects
overlapping capture requests, but does not require an active WebSocket: a
captured JPEG is atomically queued in private app storage before transfer.
Camera/image persistence and WebSocket chunk reads use separate single-thread
executors. The queue is limited to three images and 128 MiB total, retains
5 MiB of free device storage, and cleans incomplete or corrupt queue files on
startup. Completed or permanently rejected transfers are removed; pending
images survive Activity recreation, backgrounding, network loss, and process
restart.

The pairing token is intentionally regenerated on a desktop process restart.
Clients will retry transport failures, but reject an expired/old pairing token
and show an error requiring the current dashboard QR code/token to be entered.

The desktop maintains a registry for up to 32 authenticated clients. Each
dashboard device entry shows its platform, state, connection time, and most
recent activity. A disconnected device is removed from the live server registry
without affecting other clients; the dashboard retains its disconnected entry
for up to five minutes.

## Image storage and backpressure

Image data is written using asynchronous file handles and acknowledged chunks.
The server admits at most four concurrent uploads, including serialized
dashboard preview delivery, and queues up to 32 additional captures in FIFO
order. Set `TETHER_MAX_QUEUED_UPLOADS` to an integer from 0 to 512 to configure
the waiting queue. Senders receive queue position updates; full queues return a
retryable response and the sender retains the capture to retry. Duplicate
capture IDs cannot occupy multiple queue entries. Disconnects and failed
temporary-file creation release their queue slots, and the next waiting upload
is admitted automatically. Each socket also pauses reads while its bounded
message queue drains. Image files are validated in unique temporary files and
atomically published without replacing an existing capture. Disk-full and
filesystem-permission errors are reported to senders; failed/abandoned
temporary files are removed on disconnect or during startup cleanup. Shutdown
waits for active receiver cleanup before closing the server. Each committed
capture also has a flushed, atomically published metadata record containing its
capture ID, size, image type, and SHA-256 digest. Startup removes abandoned
image/metadata staging files and validates committed image signatures and
metadata before accepting clients. A retry after restart is matched against
that record and the on-disk image, so a saved-but-unacknowledged capture is
acknowledged without writing a duplicate. File contents are synced before
publication; directory-entry sync is attempted where supported by the platform
and filesystem.

## Desktop image display

The desktop renderer receives image metadata and authenticated loopback URLs,
not image bytes. Gallery previews are generated as disk-backed 480×320 WebP
thumbnails; full-resolution data is streamed only from the protected `full`
variant when needed. The original JPEG/PNG/WebP remains unchanged on disk and
is still what the export action copies. The image endpoint is restricted to
loopback requests, requires a per-process random capability token, checks the
capture metadata and digest before serving. Thumbnail files are keyed by the
capture ID and full SHA-256 digest, generated once for concurrent requests,
and cached with a 256 MiB default LRU limit and 30-day maximum age. Configure
the limits with `TETHER_THUMBNAIL_CACHE_MAX_BYTES` (1 MiB–2 GiB) and
`TETHER_THUMBNAIL_CACHE_MAX_AGE_MS` (1 minute–365 days). Startup removes
interrupted thumbnail files, expired entries, thumbnails for missing or
changed captures, and least-recently-used entries needed to meet the byte
limit. The gallery uses lazy asynchronous decoding for previews, while the
selected photo uses the full-resolution URL. The dashboard keeps at most the
200 most recent capture metadata and thumbnail URLs in React state; it never
retains full-resolution image bytes or Base64 data there. The selected photo is
one metadata record whose full image is loaded by the browser only while
selected. Toast state and timeout handles are capped, and React IPC
subscriptions unsubscribe and clear outstanding timers when the dashboard
unmounts. The pairing UI also removes its IPC subscriptions, observers, and
refresh timer on page exit.
The existing packaged dashboard expects the legacy `base64` event field, so the
preload bridge temporarily aliases that field to the thumbnail URL; it carries
no Base64 image data. The pipeline creates no object URLs.

## Original image integrity

Android CameraX supplies the captured JPEG bytes through the `ImageProxy`
encoded image plane. The Android client copies those encoded bytes once into
its pending transfer, hashes and chunks them without JPEG decoding or another
encode, and the desktop validates and persists the exact received byte stream.
The capture dimensions, JPEG quality, and embedded EXIF metadata are therefore
preserved in the saved original. Thumbnail generation is a separate derivative
operation and never rewrites the source file. The browser live-camera path
captures at the video frame's native dimensions and performs one JPEG encode
at 95% quality because browser video frames are not already JPEG files; file
picker uploads send the selected file's bytes directly.
