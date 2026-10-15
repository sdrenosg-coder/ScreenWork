---
name: Guide storage continuity
description: Data-preserving storage migration approval and environment boundaries.
---

The user approved copying guide records to private App Storage, verifying their
contents, retaining the originals, and then switching storage. PostgreSQL must
remain unchanged.

**Why:** The user wants guide data to survive restarts without losing existing
records, and explicitly chose “Copy, verify, and switch.”

**How to apply:** Never treat that approval as permission to discard originals,
overwrite conflicting destinations, replace the database, or publish the app.
Local recovery copies become stale after cloud writes and are not a safe live
fallback. Keep production and development guide registries isolated; a
development migration is not verification of an actual published restart.
