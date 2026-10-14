---
name: Upload boundary failures
description: Misleading multipart errors when native uploads meet the inherited Fetch bridge
---

A tiny valid file can trigger a generic multipart size error when its request stream was already consumed upstream; check middleware ordering before changing limits.

**Why:** The source-upload browser check rejected a valid 1,070-byte PDF with a 16 MB limit message. The inherited raw-body bridge had consumed the stream before the native multipart parser. The repaired flow passed a real upload and worker-extraction regression.

**How to apply:** For new native file endpoints, determine whether the stream or a captured Buffer owns the body. Parse once at the correct boundary, retain strict file limits and authorization, and verify with a real file rather than a JSON request.
