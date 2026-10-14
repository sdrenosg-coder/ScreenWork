---
name: Generated API compatibility
description: Orval input-type export collisions and browser header iteration requirements.
---

Generated Zod input types and generated model types can have identical names. Do not wildcard-export both sets into the same top-level barrel.

**Why:** Expanding the API exposed duplicate input declarations in Orval output, even though generation itself succeeded.

**How to apply:** Keep one authoritative top-level input type and expose the model set separately; verify shared-library compilation after regenerating. Generated browser clients may also require DOM iterable typings for `Headers.entries()`.

Orval may append a conflicting wildcard model export to an existing maintained workspace barrel during regeneration. Protect the input/model separation as part of the generation command, not as a one-off manual edit.

**Why:** A previously passing barrel can fail again after adding unrelated endpoints because the generator reintroduces the collision.
