---
name: Browser testing availability
description: Durable browser-test fallback guidance for the Replit NixOS environment.
---

When the managed browser-testing capability is unavailable, use local Playwright rather than dropping interaction verification.

**Why:** Screenshots alone cannot verify navigation, form controls, authentication and mutation results.

**How to apply:** Run browser tests locally when needed. Downloaded Chromium binaries may fail on NixOS due to missing shared libraries; prefer the platform-provided Chromium when available. Do not treat that launch failure as an application regression.
