# Local shared-daemon Kaset evidence

Live Kaset audio reached the local OpenCode sidebar beyond 30 seconds at revision `4299bb46dd183a355e2fb0c56eac1ee07fca2bde`. Explicit Stop cleared the view. This verifies one local run, not the [production release gates](music-audio-visualization-plan.md#signed-distribution-gate).

## Tested path

- Checkout: `ai-music-live-20261006`, local bookmark `work/music-live-daemon`.
- Plugin: the real `createLocalAudioPlugin` from `packages/opencode-music-player/audio-sidebar.tsx`, loaded through an isolated test wrapper. The normal local entry, `local-audio/tui.ts`, was not loaded directly.
- Daemon: `packages/music-core/session/music-sessiond.ts`, with `--local-kaset-audio` and a separate socket.
- Helper: `packages/music-core/audio/native/music-audio-helper`, built from `MusicAudioHelper.swift` and ad-hoc signed.
- Socket: `/tmp/kaset-live-43538-d05cd064.sock`.
- Host: an isolated OpenCode 2.0.24 TUI with temporary configuration. This does not broaden the pinned production host contract.
- Source: one daemon-issued Kaset WebKit process, PID `39513`. Start matched the selected launch identity, executable signing hash, and Core Audio object `234`.

This was the shared-daemon path. It did not use the direct-helper prototype or its 30-second guard. The installed preview and personal plugin configuration remained unchanged.

## Measured result

The user approved one Kaset-only run bounded to 60 seconds. The test issued one Start and one explicit Stop.

- Start request to completed Stop: **55.026 seconds**, including acquisition.
- Active status to completed Stop: **54.073 seconds**. Status timing is not a sample-duration measurement.
- Received frames: **1,017**, all with nonzero spectrum or RMS values.
- Received after the request's 30-second mark: **471**, all with nonzero spectrum or RMS values.
- Every frame included stereo channels and a signed min/max envelope.
- The spectrum sidebar still showed a signal after 30 seconds.
- Stop cleared the sidebar to capture off with no fresh signal.
- The temporary UI closed. The daemon exited with status `0`; the final process check found no native helper.

The test changed no playback, volume, audio route, or output device. The harness retained feature counts and lifecycle metadata, not PCM or feature arrays.

## Permission diagnosis

An earlier run at the same revision received 285 zero-valued frames and failed the nonzero-signal gate before 30 seconds. Zero-valued frames alone did not identify the cause.

TCC diagnostics for that failed helper request attributed `kTCCServiceAudioCapture` to Hex (`com.kitlangton.hex2`) and reported denial. Nacho manually enabled Hex in macOS **Screen & System Audio Recording**. The unchanged implementation then passed the run above.

This supports the local permission diagnosis. It does not verify a distributable helper's prompt, permission persistence, or deny/revoke behavior. No microphone capture was started.

## Ghostty launch, 2026-10-10

Two short starts used the ad-hoc helper from the public-region revision, launched by Bun under Ghostty. Each start selected the same Kaset GPU process, PID `39513`, then stopped. Playback state still arrived. No setting was changed and the existing Hex grant was not revoked.

TCC attributed both `kTCCServiceAudioCapture` requests to Ghostty (`com.mitchellh.ghostty`). It refused each request because Ghostty has no `NSAudioCaptureUsageDescription`. No prompt appeared.

The helper still reached `active` and delivered measured frames. The second start's peak spectrum was `0.72` and peak RMS was `0.048`. This does not prove whether those samples came from a prior grant or from a tap that ignores this refusal. Deny, revoke, and a signed helper remain untested.

## Evidence retained locally

The successful run's temporary artifact directory is `kaset-daemon-live-013TLv` under the approved OpenCode temporary directory. It contains `result.json`, `statistics.json`, `daemon.log`, and sidebar text snapshots before and after 30 seconds and after Stop. The failed run is `kaset-daemon-live-PuqVyy`.

This page records the measured outcome because temporary artifacts are not durable repository evidence. It omits private track metadata and frame contents.

## Not verified by this run

- Live mirror, scope, or meter rendering. The stream carried their feature data, but the live UI showed spectrum only.
- Silence during a user-controlled pause, source exit, restart recovery, device changes, or two-window live ownership.
- Isolation from another process through this shared-daemon path. The older prototype's isolation test does not establish this.
- Graceful plugin disposal. The recorded disposal hook remained `false`; the UI terminated after explicit Stop.
- Cleanup caused by last-interest disposal rather than explicit Stop, or native resource destruction independently of process exit.
- A 30-minute soak, resource growth, dropped frames, or playback-command latency under load.
- Other macOS versions, supported WebKit ownership attribution, signed distribution, notarization, or permission behavior across updates.

Ad-hoc signing and terminal permission attribution remain release blockers. Production capture remains unavailable. Further capture needs separate approval; the [local test guide](music-local-daemon-audio.md) does not authorize it.
