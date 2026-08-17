---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## Major

1. **The runnable OpenCode exit poll still does not match the bounded polling contract.** `sample_opencode_exit` returns `2` on a transient Herdr/JSON/group-sampling error, and `wait_opencode_exit` immediately returns instead of retrying until the deadline. In addition, after the 60-second loop expires, a passing final sample returns success even though the plan says that sample is diagnostic and must precede failure. Retry transient and ordinary not-yet-exited samples only within the bounded loop; after expiry, always take and record one final fresh sample and then return failure unconditionally.
