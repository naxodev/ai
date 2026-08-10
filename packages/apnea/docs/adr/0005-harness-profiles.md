# Harness abstraction: profiles with mode variants

Roles do not carry freeform model strings. Global **profiles** define `cmd_interactive` (required for dispatch) and optional `cmd_oneshot` (unused by regular Apnea dispatch). Every worker role opens the interactive harness TUI in a labeled Herdr pane so humans can watch the session. Binding a role to a profile missing `cmd_interactive` hard-errors at start. Project config may only rebind role→profile names.

Each remembered role pane stores a deterministic fingerprint of the effective profile name and interactive command. Dispatch reuses the pane only when that fingerprint still matches resolved config. Legacy pane records have no fingerprint and are recreated once rather than risking an old harness.
