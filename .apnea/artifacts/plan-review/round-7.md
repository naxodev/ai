---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## Medium — Phase 2 still lacks a self-contained pre-write baseline

The Phase 2 verify commands continue to assume an existing `APNEA_PHASE2_GUARD_DIR`, `apnea-snapshot.mjs`, and `apnea.before`, referring the implementer to an inferred “baseline half” of Phase 1. They do not create and ownership-check the guard, install the manifest program, validate the exact dispatched `pr-description.md` path as the sole artifact exclusion, or capture the baseline before drafting. This leaves Phase 2's preservation acceptance check incomplete and non-self-contained. Include those exact pre-write commands alongside the existing post-write comparison and cleanup.
