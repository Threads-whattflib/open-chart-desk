# AGENTS.md — guide for AI coding agents

`CLAUDE.md` is a symlink to this file. Human docs: `README.md`.

## Self-hosting this for your user

1. Ask (or decide from context) where it runs: their laptop, a home server / NAS, or a VPS.
2. `cp .env.example .env`. If anything other than the same machine will reach it, **set `AUTH_PASSWORD`** to a
   generated random string and give it to the user — do not leave the site open. On a VPS also put HTTPS in front
   (Caddy / nginx / Cloudflare Tunnel / Tailscale) — Basic auth over plain HTTP leaks the password.
3. Alerts: ask whether they want Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) or a webhook
   (`ALERT_WEBHOOK_URL`). Never commit `.env`.
4. `docker compose up -d --build` — there is no official prebuilt image; build locally (or use an image the user's own
   fork published, see README "Quick start"). For LAN access edit the `ports:` line in `docker-compose.yml` to `"8510:8510"`.
5. Verify, don't assume:
   - `docker compose ps` shows `healthy` after ~30 s; `docker compose logs --tail 50 chart` has no traceback and prints
     the `[alerts]` line with the notification channels.
   - `curl -u admin:$AUTH_PASSWORD "http://127.0.0.1:8510/api/bars?market=crypto&symbol=BTCUSDT&iv=1h&limit=3"`
     returns JSON with `t/o/h/l/c/v` arrays.
   - Open the page on a desktop browser **and** a phone-sized viewport (390 px wide).
6. Test alerts without waiting for the market: POST `{"market":"crypto","symbol":"BTCUSDT","price":2,"last":1,"note":"test"}`
   to `/api/alerts` — target 2 above "last" 1 makes it an "above" alert that fires on the next check. Confirm the
   notification arrived, then tell the user it was a test.

## Modifying the code

- Backend: Python 3.11, FastAPI, no ORM; state is SQLite (`data/bars.db`, `data/alerts.db`) and JSON files
  (`data/drawings/*.json`, `data/watchlist.json`, `data/settings.json`). Every config value is an env var.
- Frontend: React 18 + TypeScript + Vite, no UI framework, hand-written CSS in `web/src/styles.css`.
  `npm run build` runs `tsc -b` — it must pass with no errors.
- `lightweight-charts` is pinned to an exact version on purpose; drawing tools are a series primitive
  (`web/src/draw/layer.ts`) that relies on its internals staying stable. Upgrade deliberately and retest every tool.
- Keep the Lightweight Charts attribution logo (`attributionLogo: true`) — it is a license condition.
- All times are UTC seconds; daily-and-above bars use the trading day's UTC midnight. Drawings store times, not bar
  indexes, so they line up across intervals.
- Browser never calls exchanges directly; add new data sources in `server/data_sources.py` and keep the
  `/api/bars` response shape (`t,o,h,l,c,v` parallel arrays + `more`).
- Adding a market: extend `MARKETS`, `SYM_RE`, `intervals()`, `bars()`, `quotes()` and `search()` in
  `data_sources.py`, then the `Market` type in `web/src/types.ts`.
- Adding an alert channel: add it to `_notify()` in `server/alerts.py` and document the env var in `.env.example`
  and `README.md`.
- Touch input has hand-tuned values (pinch gain `PINCH_GAIN` in `web/src/draw/controller.ts`, wheel snapping in
  `styles.css`). Change them only on purpose and test on a real phone.

## Checks before you say it works

- `cd web && npm run build` passes.
- `docker build .` passes and the container reaches `healthy`.
- Desktop (≥ 1280 px) and phone (390 px) both load with no console errors and no horizontal scroll; you can draw a
  trend line, move it, open its settings sheet and undo.
- Secrets (`.env`, tokens) are not in git: `git status` and `git diff --cached` before committing.
