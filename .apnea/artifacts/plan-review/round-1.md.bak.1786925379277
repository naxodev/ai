---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High — Phase 2 verification is not self-contained or suitable for `apnea commit`

The Phase 2 command list depends on transient interactive state that the commands neither create nor preserve. In one sequence it requires exactly one live `music-sessiond` and socket, then requires that daemon and its artifacts to be absent, but launching the two pinned hosts, loading the checkout integrations, performing the bidirectional controls/reload/exit flow, waiting for idle cleanup, and transitioning between the live and closed states are only prose. A fresh-shell verifier cannot run the listed commands successfully as a coherent gate after the coder has finished and closed the hosts.

Revise Phase 2 so the verification contract is executable and unambiguous: separate prerequisite, live-session, and post-close checks into explicitly staged self-contained commands or provide a phase-local verification harness/evidence artifact that `apnea commit` can validate after the interactive run. The retained evidence must bind the observations to the exact host versions and checkout paths and cover daemon PID/generation, socket ownership/mode, provider ownership, Pi reload, client exits, and final idle cleanup. Do not leave mutually exclusive live and post-cleanup assertions as an unstaged flat command list.
