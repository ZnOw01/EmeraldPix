# Changelog

## 3.5.3 - 2026-05-19

### Added
- Improved scroll detection for complex pages (Google Drive) using ARIA roles and extended selectors.
- Intelligent blank-frame detection in the capture pipeline with automatic retry logic.

### Changed
- UI: Completely overhauled design with "Premium Emerald" aesthetics, including glassmorphism, mesh gradients, and sequential entry animations.
- UI: Refined status panel and progress bar with pulse/shimmer effects.
- Security: Updated dependencies to resolve high-severity vulnerabilities (CVEs).

### Fixed
- Fixed critical TypeScript errors in `page-scanner.ts`, `canvas-compositor.ts`, and `export-engine.ts` preventing production builds.
- Fixed `actualY is not defined` runtime error in the content script due to minification scoping issues.


### Changed

- Improved capture-plan validation so non-finite page or viewport dimensions cannot create unbounded tile plans.
- Hardened offscreen canvas cleanup for exported, cleared, and stale capture jobs.
- Made persisted settings comparison stable for nested values without relying on JSON key order.
- Updated E2E coverage for the current EmeraldPix popup copy and bundled Chromium execution.

### Fixed

- Fixed lint drift from an unused content-script constant.
- Fixed E2E startup hangs by using the bundled Chromium channel in CI-style runs and adding a bounded service-worker wait.
- Fixed E2E download assertions to validate PNG output by file contents instead of Chromium's temporary download filename.

## 3.4.0 - 2026-03-14

### Added

- Added a redesigned popup settings experience with explicit theme selection, JPG quality control, save-dialog preference, and reusable icon/copy modules.
- Added regression coverage for popup settings, theme persistence, download requests, persisted storage, version sync, and container-scroll/full-page E2E capture paths.

### Changed

- Refined popup layout, status rendering, keyboard handling, and modal accessibility to make capture progress and settings easier to use.
- Synced persisted settings through both `chrome.storage` and IndexedDB more defensively, including targeted key clearing instead of blanket storage wipes.
- Expanded CI and release workflows with formatting and test gates, plus optional coverage support in Vitest.

### Fixed

- Fixed capture tile metadata and validation so viewport, screenshot, and crop dimensions stay explicit through the pipeline.
- Improved long-page and internal scroll-container capture reliability to reduce clipped or incomplete exports.

## 3.3.1 - 2026-03-13

### Fixed

- Moved global `declare const` statements to a dedicated `svelte.d.ts` ambient declaration file to resolve TypeScript errors in Svelte components.

## 3.3.0 - 2026-03-06

### Changed

- Hardened capture pipeline: content-script injection now verified with a build-ID handshake; listener registration is idempotent across hot-reloads.
- Removed dead modules (accessibility, analytics, annotations, database, feedback, i18n, image-compression, ocr, sentry) and their npm dependencies.
- Replaced fragile per-file locale strings with a single English inline `COPY` dictionary in the popup.
- Brand icon redesigned: generated as PNG at all required sizes from an inline SVG; no external file dependency.
- `content_script.js` bundle is now fully self-contained (no ES module `import` statements) so `chrome.scripting.executeScript` injection works correctly on all supported Chrome versions.
- Expanded CI quality gates: coverage gate, lint/test gates in release workflow, corrected branch triggers.
- Added project copyright notice (`Copyright (C) 2026 ZnOw01`) and explicit `GPL-3.0-only` declaration to `LICENSE`.
- Improved `README.md`: added captured screenshots, _Why EmeraldPix_ comparison table, and updated badge to `GPL-3.0-only`.
- Removed unused test dependencies (`@playwright/test`, `@testing-library/*`, `msw`) from `package.json`.

### Fixed

- `Unable to initialize capture pipeline` error caused by a shared Rollup chunk being injected as a classic script.
- `JOB_TIMEOUT_MS` duplicate constant in content script removed; now sourced locally to keep the bundle self-contained.
- Backend `server.mjs` hardened: CORS, OPTIONS pre-flight, rate limiting, webhook HMAC verification, graceful shutdown.
