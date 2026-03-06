# Changelog

## 3.3.0 — 2026-03-06

### Changed
- Hardened capture pipeline: content-script injection now verified with a build-ID handshake; listener registration is idempotent across hot-reloads.
- Removed dead modules (accessibility, analytics, annotations, database, feedback, i18n, image-compression, ocr, sentry) and their npm dependencies.
- Replaced fragile per-file locale strings with a single English inline `COPY` dictionary in the popup.
- Brand icon redesigned: generated as PNG at all required sizes from an inline SVG; no external file dependency.
- `content_script.js` bundle is now fully self-contained (no ES module `import` statements) so `chrome.scripting.executeScript` injection works correctly on all supported Chrome versions.
- Expanded CI quality gates: coverage gate, lint/test gates in release workflow, corrected branch triggers.
- Added project copyright notice (`Copyright (C) 2026 ZnOw01`) and explicit `GPL-3.0-only` declaration to `LICENSE`.
- Improved `README.md`: added captured screenshots, *Why EmeraldPix* comparison table, and updated badge to `GPL-3.0-only`.
- Removed unused test dependencies (`@playwright/test`, `@testing-library/*`, `@vitest/coverage-v8`, `msw`, `vitest`) from `package.json`.

### Fixed
- `Unable to initialize capture pipeline` error caused by a shared Rollup chunk being injected as a classic script.
- `JOB_TIMEOUT_MS` duplicate constant in content script removed; now sourced locally to keep the bundle self-contained.
- Backend `server.mjs` hardened: CORS, OPTIONS pre-flight, rate limiting, webhook HMAC verification, graceful shutdown.
