# EmeraldPix

[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)

Screenshot extension. Captures full pages or selected areas with smart scrolling, exports to PNG, JPG or PDF, and works entirely locally — no account, no servers, no uploads.

![Capture in progress](docs/screenshots/active-screenshot.png)
![Capture complete](docs/screenshots/screenshot-in-progress.png)

## Why EmeraldPix

| | EmeraldPix |
|---|---|
| **Full-page capture** | Scrolls the page automatically, including lazy-loaded images, so nothing is cropped |
| **Area selection** | Drag a region on the visible viewport for precise partial captures |
| **Three export formats** | PNG, JPG, or PDF — chosen per capture, no settings menu needed |
| **100 % local** | All processing runs inside your browser; no pixel ever leaves your machine |
| **No account required** | Install from source and start capturing immediately |

## Features

- Full-page capture including lazy-loaded content
- Area capture for visible-page selections
- Export to PNG, JPG, or PDF
- Dark/Light mode follows system preference
- Keyboard shortcut: `Alt + Shift + P`

## Quick Start

1. Click the EmeraldPix icon in the toolbar
2. Choose your export format
3. Click **Page** or **Area**
4. File saves to Downloads automatically

## Install from source

```bash
npm install
npm run build
```

Then load the extension:

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder

## Development

Watch mode rebuilds `dist/` on every file save and triggers an auto-reload of the unpacked extension:

```bash
npm run dev:ext
```

The settings panel shows a `dev ...` badge so you can confirm the browser picked up the latest build.

## Commands

| Command              | Description                        |
| -------------------- | ---------------------------------- |
| `npm run build`      | Type-check + production build      |
| `npm run build:fast` | Production build, skip type-check  |
| `npm run dev:ext`    | Watch build for extension dev loop |
| `npm run typecheck`  | TypeScript type-check only         |
| `npm run lint`       | ESLint                             |
| `npm run format`     | Prettier check                     |

## Project layout

```text
src/
  background/   service worker - capture orchestration
  content/      content script - page measurement, tile scrolling, area selection
  offscreen/    offscreen document - image composition and PDF export
  popup/        extension popup UI (Svelte)
  shared/       types, utilities, constants

scripts/
  generate-icons.mjs   re-generates PNG icons from the inline SVG
  verify-icons.mjs     pixel-level verification of generated icons
```

## Permissions

| Permission         | Why it is needed                              |
| ------------------ | --------------------------------------------- |
| `<all_urls>`       | Capture any normal webpage                    |
| `downloads`        | Save files to the user's Downloads folder     |
| `offscreen`        | Compose and encode images off the UI thread   |
| `scripting`        | Inject the capture content script into a page |
| `storage`          | Persist settings                              |
| `tabs` / `activeTab` | Read the active tab URL and capture state   |

Restricted pages (`chrome://`, `edge://`, Chrome Web Store) are blocked and cannot be captured.

## Privacy

All capture and export work happens locally inside the browser. No screenshot data is sent anywhere.

## Changelog

See [CHANGES.md](CHANGES.md).
