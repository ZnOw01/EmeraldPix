# EmeraldPix Privacy Policy

Last updated: 2026-03-14

EmeraldPix is a browser extension for capturing full pages or selected screen areas and exporting the result to PNG, JPG, or PDF.

## Summary

- EmeraldPix does not require an account.
- EmeraldPix does not upload captures to our servers.
- EmeraldPix does not sell personal data.
- EmeraldPix does not include advertising, analytics, or behavioral tracking.

All capture processing happens locally in the browser on the user's device.

## What data the extension can access

EmeraldPix may access:

- the currently active tab when the user starts a capture
- page content needed to measure and stitch a full-page capture
- extension settings stored locally in the browser
- downloaded file metadata required to save the exported capture

## Why this access is needed

The extension uses browser permissions only to provide capture functionality:

- `<all_urls>` and `scripting` let the extension measure pages and inject the capture helper when the user starts a capture
- `tabs` and `activeTab` let the extension identify the page being captured
- `offscreen` lets the extension compose images and generate PDFs without blocking the popup
- `downloads` lets the extension save the exported file to the user's device
- `storage` lets the extension remember settings such as export format, theme, and save preferences

## Data sharing

EmeraldPix does not transmit captured page content, exported files, or local settings to a remote server controlled by the publisher.

Data may still be handled by the browser vendor or the operating system as part of normal browser features, such as the local Downloads folder or the browser's own sync settings if the user has enabled them.

## Data retention

EmeraldPix stores settings locally in browser-managed storage until the user resets them, removes them, or uninstalls the extension.

Captured files are stored only where the user chooses to save them.

## User choices

Users can:

- remove exported files from their device at any time
- reset saved preferences from the extension settings
- remove the extension from the browser

## Contact

Project repository: https://github.com/ZnOw01/EmeraldPix

Support and issues: https://github.com/ZnOw01/EmeraldPix/issues
