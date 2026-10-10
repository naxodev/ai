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

## Isolated permission matrix, 2026-10-10

An ad-hoc signed test app with `NSAudioCaptureUsageDescription` launched the helper through Bun. Its bundle ID was `dev.naxo.music.permission-matrix.j8vudl`. Each approved probe selected the existing Kaset GPU process and stopped after 15 seconds. The harness retained feature counts, peak levels, helper hashes, and lifecycle metadata. It saved no audio or feature arrays.

The original temporary bundle received a grant but did not appear in System Settings. TCC could not resolve its application URL. A bundle-specific `tccutil reset AudioCapture` also failed with `kLSApplicationNotFoundErr`. Moving the test app into the project folder and registering that path made the scoped reset succeed. The app then appeared under **System Audio Recording Only**.

The first probe after reset still received a grant. TCC recorded `AUTHREQ_PROMPTING` for the responsible test app, followed by `authValue=2`, `authReason=2`. The helper delivered 208 frames, all nonzero, over 15.038 seconds. Peak RMS was `0.084`; peak spectrum was `0.805`. The stage name `deny` did not describe the permission decision. This run did not verify denial.

Switching the test app off in System Settings established a real denial. TCC returned `authValue=0`, `authReason=4`, without a prompt. The helper still emitted 265 feature frames, all zero. Enabling the same entry and choosing **Quit & Reopen** restored nonzero frames. An unchanged-helper retry retained the grant without another prompt.

| Probe                                            | TCC decision   | Prompt events | Frames | Nonzero frames | Helper runtime |
| ------------------------------------------------ | -------------- | ------------- | -----: | -------------: | -------------: |
| After scoped reset (`deny`)                      | Allowed, `2/2` | 1             |    208 |            208 |       15.038 s |
| Settings off (`denied-retry`)                    | Denied, `0/4`  | 0             |    265 |              0 |       15.043 s |
| Settings on (`allow`)                            | Allowed, `2/4` | 0             |    263 |            263 |       15.045 s |
| Unchanged helper (`allowed-retry`)               | Allowed, `2/4` | 0             |    263 |            263 |       15.033 s |
| Rebuilt helper (`updated-helper`)                | Allowed, `2/4` | 0             |    263 |            263 |       15.040 s |
| Settings off and app restarted (`revoked-retry`) | Denied, `0/4`  | 0             |    265 |              0 |       15.028 s |

Decision pairs are `authValue/authReason`. Counts describe helper feature frames, not PCM buffers. A denied request producing zero-valued frames fails the intended requirement that denial stop feature delivery. Zero features alone cannot distinguish denied access from silence.

The update experiment keeps the helper outside the app's sealed resources. The rebuilt helper adds only `CFBundleVersion=2` to its embedded property list and retains identifier `dev.naxo.music.audio-helper`. Its ad-hoc CDHash changes from `80dd10714e183291b8fe513fef7c21169835c1c1` to `ab43b503a4d5699124774da1a0fd751b36b7e5a1`. The responsible app's CDHash remains `5f8900aaa8875afa0d6469432eb7adbcd8af74bd`. Strict signature verification passes for both helpers and the unchanged app.

That helper replacement retained the grant without a new TCC prompt event. This verifies one changed helper under a fixed responsible app. It does not verify changes to the app itself, package paths, terminal launch layouts, or Developer ID distribution.

Revocation also blocked nonzero features after **Quit & Reopen**, but feature delivery continued. System Settings warned that the running app could retain access until it quit. This experiment did not test revocation during an active capture or declining the initial permission prompt.

The helper runs directly in this harness. These results do not verify the daemon's `active` status or sidebar behavior under denied permission. The deny/revoke requirement to stop feature delivery failed. The production permission gate remains open.

## Evidence retained locally

The successful run's temporary artifact directory is `kaset-daemon-live-013TLv` under the approved OpenCode temporary directory. It contains `result.json`, `statistics.json`, `daemon.log`, and sidebar text snapshots before and after 30 seconds and after Stop. The failed run is `kaset-daemon-live-PuqVyy`.

The permission matrix artifacts are in `music-permission-matrix-J8VUDL` under the same temporary directory. `matrix-results/` retains all six probe results. The corresponding `<stage>-tcc.json` files retain AudioCapture requests correlated by helper PID and TCC message ID. Helper PIDs were `98142`, `1754`, `2168`, `2540`, `2797`, and `3492`, in table order.

Cleanup removed the test app's permission entry, both bundle registrations, and both test bundles. A final process check found no test launcher, probe, or native helper. The experiment changed no playback settings, installed preview, or personal plugin configuration. Hex and Ghostty grants remained unchanged.

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
