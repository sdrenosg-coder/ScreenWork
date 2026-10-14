---
name: Browser testing availability
description: Durable browser-test fallback guidance for the Replit NixOS environment.
---

When the managed browser-testing capability is unavailable, use local Playwright rather than dropping interaction verification.

**Why:** Screenshots alone cannot verify navigation, form controls, authentication and mutation results.

**How to apply:** Run browser tests locally when needed. Downloaded Chromium binaries may fail on NixOS due to missing shared libraries; prefer the platform-provided Chromium when available. Do not treat that launch failure as an application regression.

Long asynchronous jobs can outlast a managed browser step's 45-second wait ceiling and reset the browser notebook.

**Why:** A real AI job completed successfully while the browser lost its notebook during the wait. Resubmitting would have spent credits again.

**How to apply:** Recover from persisted server job status and draft metadata after a browser reset. Never send another model request solely because a browser wait timed out.
