# M3U Playlist Scanner

A privacy-first browser tool for parsing and checking authorized Xtream-compatible playlist credentials.

## Features

- Paste credential text or load a local `.txt` file
- Parse M3U URLs, CSV, JSON-like logs, labeled fields, and host/user/password rows
- Check public HTTPS endpoints with bounded concurrency and request timeouts
- Filter by minimum connections, sort results, and switch between M3U and Xtream views
- Browse live, movie, and series categories when the service supports them
- Export working results to formula-safe CSV
- Download a self-contained portable HTML edition from GitHub Releases

## Security model

Input files are read locally and are not persisted. Untrusted values are rendered as text rather than injected as HTML. The scanner blocks localhost and private-network targets, caps input and response sizes, masks passwords by default, encodes query values, and omits browser credentials and referrers from requests. The private hosted site sends one credential at a time to its same-origin checker so it can securely reach authorized HTTP-only services.

Only use the scanner with playlists and services you own or are authorized to access. The GitHub Pages and portable editions make requests directly from the browser, so HTTP-only endpoints and hosts without compatible CORS headers require the private hosted version. Policy-blocked requests are reported as blocked rather than misclassified as inactive.

## Portable edition

Download `M3U-Playlist-Scanner.html` from the latest GitHub Release and open it in a modern browser. It is a single file with no installation or external assets. Drag-and-drop, local `.txt` loading, parsing, checking, result filtering, and CSV export all run in the browser.

To rebuild it:

```bash
pnpm build:standalone
```

## Development

```bash
pnpm install
pnpm dev
```

Run the validation suite with:

```bash
pnpm test
pnpm lint
pnpm build
```

The GitHub Actions workflow publishes the static build to GitHub Pages after changes reach `main`.
