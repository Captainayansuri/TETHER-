# Stress testing

Run `npm run stress` from the repository root to exercise the production desktop image receiver, upload queue, file persistence, and recovery code with 1,000 transfers across eight simulated connected devices. The harness generates decoder-valid JPEGs, injects slow disk writes, partial-transfer disconnects, an intentionally lost acknowledgement followed by same-ID retransmission, malformed metadata, oversized metadata, invalid image bytes, and a storage recovery restart between transfer batches.

The run writes `stress-report.json` and `stress-report.md` in the repository root. A nonzero exit code means one or more transfer integrity, recovery, queue, or memory checks failed. The defaults can be adjusted through `STRESS_IMAGES`, `STRESS_DEVICES`, `STRESS_SLOW_DISK_MS`, `STRESS_MEMORY_BUDGET_MB`, `STRESS_MAX_IMAGE_MB`, and `STRESS_REPORT_DIR`.

This is a desktop protocol and storage integration harness. Android reconnection is represented by reconnecting a simulated Android device session and retrying its persistent capture ID; it does not launch an Android runtime or a physical device. WebSocket transport scheduling and the Electron process itself are not restarted by the harness; it closes transfer sessions, rebuilds the bounded queue, and runs the production storage recovery routine against the same capture directory.
