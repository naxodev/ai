# Package screenshots and demos

These Cap captures show the package interfaces with isolated demo data. Click a screenshot for its full size. Watch the silent clips on Cap or download the MP4 backups from this repository.

| Package and captured version                                                                    | Screenshot                                                           | Demo                                                                                  |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [OpenCode music-player](../../packages/opencode-music-player/README.md) 0.4.2 · OpenCode 2.0.16 | [Artwork, seeking, and transport](opencode-music-player/preview.png) | [Watch 19s](https://cap.so/s/97eecxhba8e6vs1) · [MP4](opencode-music-player/demo.mp4) |
| [OpenCode Vim](../../packages/opencode-vim/README.md) 0.3.1 · OpenCode 2.0.16                   | [Visual selection in the prompt](opencode-vim/preview.png)           | [Watch 20s](https://cap.so/s/fab9gyem6ecsazq) · [MP4](opencode-vim/demo.mp4)          |
| [Pi music-dock](../../packages/pi-music-dock/README.md) 0.2.0 · Pi 0.84.2                       | [Native cover and music panel](pi-music-dock/preview.png)            | [Watch 14s](https://cap.so/s/m1vdnkznatga1fy) · [MP4](pi-music-dock/demo.mp4)         |
| [Apnea](../../packages/apnea/README.md) 0.2.3                                                   | [Planning state and next action](apnea/preview.png)                  | [Watch 16s](https://cap.so/s/0ywqb45v5bc209y) · [MP4](apnea/demo.mp4)                 |
| [Pi-Apnea](../../packages/pi-apnea/README.md) 0.2.3 · Pi 0.84.2                                 | [Command reference in Pi](pi-apnea/preview.png)                      | Screenshot only                                                                       |
| [Music-core](../../packages/music-core/README.md) 0.1.5                                         | [Architecture and visualization](music-core/preview.png)             | [Watch 18s](https://cap.so/s/sejery4s2bkx78a) · [MP4](music-core/demo.mp4)            |

## What the captures establish

- Music demos use the real host interfaces with injected playback fixtures. They do not control system playback. The sunset cover is original artwork made for these demos.
- The Vim 0.3.1 clip demonstrates insert mode, normal motions, visual selection, `x`, `.`, and two separate undo steps. The capture script asserts each resulting prompt, and the period comes through a macOS keyboard event. The original literal-period failure from [#206](https://github.com/naxodev/ai/issues/206) is fixed. We excluded a separate word-deletion take; [#208](https://github.com/naxodev/ai/issues/208) tracks that discrepancy. This clip verifies character deletion, not `dw`.
- Apnea uses a real workflow in an isolated jj repository. The visible `head -n 18` command limits the CLI status output. No roles were dispatched.
- Pi-Apnea shows its actual help handler in a labeled scripted demonstration. It does not show a completed workflow or model execution.
- Music-core runs its exported waveform functions with synthetic samples. The diagram illustrates daemon ownership; it is not a recording of a multi-client daemon test. The visualization is not an audio spectrum analyzer.

## Capture and maintenance

We captured the approved set on 27 September 2026 with Cap Desktop 0.6.0 and CLI 0.1.0. Dedicated Ghostty windows provided the capture targets. We captured Pi's native artwork directly rather than through tmux and replaced obscured takes before approval. The Music-core exports crop out an unrelated terminal caption below the library output.

All five Cap projects validated. Each exported video fully decoded with FFmpeg and has no audio stream. The editable `.cap` masters remain outside the repository; this directory contains only the reviewed PNG and MP4 exports.

The verified Vim 0.3.1 take replaces the initial three-mode clip. The [original Cap](https://cap.so/s/690b7p6p2q2rkdz) remains available for historical reference.

Package READMEs use absolute public image URLs and public Cap watch links so the media does not depend on an npm tarball's directory layout. MP4 backups stay under `docs/media`, outside package publish roots. Cap confirms that all five uploads are complete and public without password protection. We requested neither transcripts nor AI processing. New captures must retain useful alternative text, state any fixtures or limitations, and pass package-content checks before replacing this set.
