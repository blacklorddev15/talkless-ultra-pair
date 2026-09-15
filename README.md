# TALKLESS ULTRA — pairing portal

Static site + Vercel serverless functions for https://talkless-ultra-pair.vercel.app.

There is **no build step**: `index.html`, `admin.html`, `style.css`, `script.js` and
`admin.js` are served as-is, and everything under `api/` becomes a serverless function.

| Path | Served as |
|---|---|
| `index.html` | the pairing page |
| `admin.html` | the admin dashboard (password-protected) |
| `style.css`, `script.js`, `admin.js` | assets |
| `api/stats.js` | `GET /api/stats` — the numbers on the landing page |
| `api/request.js` | `POST /api/request` — creates a pairing request |
| `api/status.js` | `GET /api/status?id=` — polled until a code appears |
| `api/admin.js` | `POST /api/admin` — the admin actions |
| `api/_db.js` | shared database layer (underscore = not routable) |
| `talkless-ultra.apk` | the Android app, downloadable from the landing page |

## The one thing to be careful about

Every table name is prefixed **`talkless_`**, hardcoded in `api/_db.js`:

```js
const PREFIX = 'talkless_';
```

The Neon database this project points at is **shared with the other brand portals** —
it holds `skylar_sessions`, `varnox_sessions`, and an unprefixed `sessions` table among
others. So a wrong or missing prefix does not error, it silently reads and writes another
brand's data. If you ever point this at a fresh database, set the prefix deliberately.

Runtime configuration lives in the Vercel project, not here:

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | the control database connection string |
| `ADMIN_PASSWORD` | the admin dashboard password |

Never commit values for these.

## Deploying

```bash
npx vercel@latest pull     # link the project once
npx vercel@latest --prod   # deploy
```

Deploy to a **preview** first (`npx vercel@latest`) and check it before promoting: the API
is what the live bot and the pairing page both depend on, and a bad prefix or a missing
table shows up as wrong numbers rather than an error.

## Admin actions

`login`, `stats`, `sessions`, `keys`, `generate_key`, `set_notice`, `set_premium`,
`current_db`, `switch_db`, `servers`, `reset_heartbeats`, `test_db`,
**`delete_session`**, **`clear_sessions`**.

`delete_session` takes `{ id }` and removes one row. `clear_sessions` only ever touches
rows whose status is exactly `disconnected`; pass `{ dryRun: true }` to count first.

Both only clear the database. Revoking the WhatsApp link itself is the bot's job
(`/delpair`), which also removes `./sessions/<id>`.

## Note on `/api/status`

The response is deliberately limited to `status`, `pairing_code`, `error` and `expires_at`.
It is unauthenticated and request ids are sequential, so returning `phone` (as an earlier
build did) turns the endpoint into a bulk phone-number scraper. The pairing page only needs
those four fields.
