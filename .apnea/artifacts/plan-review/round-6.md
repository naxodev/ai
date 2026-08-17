---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## Medium — Phase 2's preservation check remains non-self-contained

The Phase 2 verify block still begins with an already-created `APNEA_PHASE2_GUARD_DIR` and assumes `apnea-snapshot.mjs` and `apnea.before` were produced “using the Phase 1 snapshot procedure.” No Phase 2 command creates and ownership-checks the guard, writes the snapshot program, validates the exact dispatched `pr-description.md` path as the exclusion, or captures the pre-write manifest. Requiring the future phase package to infer a “baseline half” from Phase 1 is not a self-contained verify procedure. Include the complete pre-write setup/baseline and post-write comparison/cleanup commands in Phase 2.
