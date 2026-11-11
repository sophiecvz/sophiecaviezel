# 🤍 Sophie Caviezel

a minimal, responsive personal landing page for Sophie Caviezel, featuring a profile portrait, Telegram and Fanvue links, and social media profiles

## tech stack

- HTML5
- CSS3
- vanilla JavaScript
- Vite 8
- Node.js 24
- npm
- Prettier
- Cloudflare Pages and Pages Functions
- Cloudflare D1 (SQLite)
- Cloudflare Workers (rate limiting)
- `isbot` 5.2.2
- Wrangler 4
- Node.js built-in test runner

built with native HTML, CSS, and minimal vanilla JavaScript, without a frontend framework

## requirements

- Node.js 24 LTS
- npm

the Node.js version is specified in [`.node-version`](.node-version)

## getting started

install dependencies:

```bash
npm ci
```

start the development server:

```bash
npm run dev
```

`npm run dev` runs the frontend only; Cloudflare Functions, D1, and rate limiting are not included in the Vite development server

## available scripts

| command                | description                              |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | start the frontend development server    |
| `npm run build`        | create a production build in `dist/`     |
| `npm run preview`      | preview the built frontend locally       |
| `npm test`             | run automated tests                      |
| `npm run format`       | format files with Prettier               |
| `npm run format:check` | check formatting without modifying files |

## analytics

Sophie Analytics records page views and Telegram/Fanvue button clicks by UTM source, using Cloudflare Pages Functions and D1

requests are validated, known bots are filtered, and a private Cloudflare Worker rate-limits the event API; no tracking cookies, persistent visitor IDs, or device fingerprints are used

metrics count events, not unique visitors; missing or unsupported sources are recorded as `unknown`

[analytics documentation](docs/analytics/README.md)
