# Dashboard

`apps/dashboard` is a static web app showing live network progress (spec §37)
and a public page per project (§38). It uses only the coordinator's public,
unauthenticated endpoints and contains no admin functionality.

## Views

| Route            | Shows                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `#/`             | Network counts, compute donated, projects with progress, recent workers                                                         |
| `#/projects/:id` | Goal, progress, contributors, compute donated, and the full prompt template, requirements, and schemas volunteers execute (§44) |

Data comes from `GET /api/v1/network` (polled every 5 s while the tab is
visible, with exponential backoff up to 60 s on failure) and
`GET /api/v1/projects/:id`. Every response is validated with the protocol
schemas; on failure the last good data stays on screen under an error banner.

Local inference and paid API spend are shown separately. There is no USD
figure for volunteer hardware because no defensible normalization exists yet
(§26).

## Running

```sh
# Development: Vite dev server, proxies /api to a coordinator on :8080
pnpm --filter @ai-commons/dashboard dev

# Production: build, then let the coordinator serve it
pnpm --filter @ai-commons/dashboard build
DASHBOARD_DIR=apps/dashboard/dist node apps/coordinator/dist/index.js
```

`VITE_COORDINATOR_URL` (build time) points the dashboard at a coordinator on
another origin; the default is same-origin. The coordinator does not send CORS
headers, so cross-origin hosting additionally needs a reverse proxy.

## Security

- Coordinator data is untrusted. Views are built with a small `h()` helper that
  inserts strings as text nodes; `innerHTML` is never used and event-handler or
  `style` attributes are refused. Tests cover hostile project names.
- When served by the coordinator, `index.html` carries a CSP allowing only
  same-origin scripts, styles, and connections. Dynamic widths use CSSOM
  (`element.style.width`), which that CSP permits.
- No cookies or credentials are sent (`credentials: 'omit'`).
- Workers are shown only by random ID, status, task count, and last-seen time
  (§52). A worker unseen for three heartbeat intervals is shown as offline.
