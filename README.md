# M3U Playlist Scanner

A privacy-first browser tool for parsing and checking authorized Xtream-compatible playlist credentials.

## Features

- Paste credential text or load a local `.txt` file
- Parse M3U URLs, CSV, JSON-like logs, labeled fields, and host/user/password rows
- Check public HTTPS endpoints with bounded concurrency and request timeouts
- Filter by minimum connections, sort results, and switch between M3U and Xtream views
- Browse live, movie, and series categories when the service supports them
- Export working results to formula-safe CSV

## Security model

Input files are read locally and are not uploaded or persisted. Untrusted values are rendered through React rather than injected as HTML. The scanner blocks localhost and private-network targets, caps input and response sizes, masks passwords by default, encodes query values, omits browser credentials and referrers from requests, and ships with a hash-based Content Security Policy.

Only use the scanner with playlists and services you own or are authorized to access. Because the deployed site uses HTTPS and does not relay traffic through a proxy, HTTP-only endpoints and hosts without compatible CORS headers cannot be checked.

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
