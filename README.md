# open-chart-desk

[![image](https://github.com/Threads-whattflib/open-chart-desk/actions/workflows/image.yml/badge.svg)](https://github.com/Threads-whattflib/open-chart-desk/actions/workflows/image.yml) ![license](https://img.shields.io/badge/license-MIT-blue)

A self-hosted, TradingView-style charting web app for **crypto, Taiwan stocks and US stocks**:
drawing tools that persist on your server, watchlists, indicators, price alerts (Telegram / webhook),
and a phone layout modelled on mobile charting apps. One Docker container, no account, no paid data feed.

自架的看盤網頁：加密貨幣、台股、美股；畫線存在自己的伺服器、觀察清單、指標、價格提醒（Telegram / webhook），
電腦版與手機版各一套版面。一個 Docker 容器，不用帳號、不用付費資料源。介面是繁體中文。

> Not affiliated with TradingView. The chart engine is TradingView's open-source
> [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0); its attribution logo stays on.
> Market data comes from public endpoints of Binance / Bybit / Yahoo / TWSE — personal use only, may be delayed. See `NOTICE`.

This repo is meant to be **forked and modified**. It is a snapshot, not a maintained product: issues and PRs may go unanswered.
AI coding agents: read [`AGENTS.md`](./AGENTS.md) first.

## Quick start

```bash
git clone https://github.com/Threads-whattflib/open-chart-desk.git
cd open-chart-desk
cp .env.example .env          # optional: set AUTH_PASSWORD, Telegram, webhook
docker compose up -d --build
# open http://127.0.0.1:8510/
```

There is no official prebuilt image — build it yourself (the command above does), or let your fork build one:
fork the repo, enable Actions on the fork, push to `main`, and `.github/workflows/image.yml` publishes
`ghcr.io/<your-user>/open-chart-desk:latest` (amd64 + arm64, handy for small NAS boxes that build slowly). The package
starts private: `docker login ghcr.io` before pulling, or make it public on your package's settings page. Then replace
`build: .` with `image: ghcr.io/<your-user>/open-chart-desk:latest` in `docker-compose.yml`.

By default the port is bound to **127.0.0.1 only**. To use it from your phone on the LAN, change the port mapping to
`"8510:8510"` **and set `AUTH_PASSWORD`**. Never expose it to the internet without a password; put it behind HTTPS
(reverse proxy, Tailscale, Cloudflare Tunnel) if you do.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8510` | Host port |
| `AUTH_USER` / `AUTH_PASSWORD` | `admin` / empty | HTTP Basic login for the whole site. The live-price WebSocket also accepts an HttpOnly cookie set after login (Safari does not resend Basic credentials there). Empty = no login |
| `CHART_DESK_DATA` | `/app/data` | Data folder (bars, drawings, watchlist, alerts, logo cache). Keep it on the volume |
| `ALERT_INTERVAL` | `15` | Seconds between alert price checks (min 5) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | empty | Send triggered alerts to Telegram |
| `ALERT_WEBHOOK_URL` | empty | POST triggered alerts as JSON (`text` for Slack, `content` for Discord, plus raw fields) |

Test the channels after setting them: `curl -u admin:<password> -X POST http://127.0.0.1:8510/api/alerts/test` sends one
test message and reports `ok` or the error per channel.
| `LOGO_SOURCE` | `favicon` | Symbol icons: `favicon` (company website icon), `tradingview` (unofficial endpoint — may break their ToS, your call), `none` |

Data (bar cache, drawings, watchlist, settings, alerts) lives in the `chart-data` volume at `/app/data`. Deleting
`bars.db` is safe; it rebuilds.

## Features

- **Markets**: crypto (Binance spot, falls back to Bybit), Taiwan stocks (Yahoo + TWSE MIS real-time price),
  US stocks / ETFs / indices / futures in Yahoo notation (`^VIX`, `GC=F`). Type anywhere to search.
- **Intervals**: crypto 1m … 1M (11); stocks 1m, 5m, 15m, 30m, 1h, 1D, 1W, 1M.
- **Default watchlist**: 79 symbols in themed groups (crypto majors, Taiwan semis / AI servers, US big tech / AI semis /
  ETFs / indices) — edit `DEFAULT_WATCH` in `web/src/types.ts`, or just change it in the app (saved server-side). First load
  of prices takes 10–20 s while Yahoo is queried; cached after that.
- **Live**: crypto via Binance WebSocket relay; TW every 5 s; US every 20 s. US pre/post-market in intraday bars and watchlist.
- **Local bar database** (SQLite): charts open from disk, only the tail is fetched; watchlist × favourite intervals pre-synced.
- **Chart**: candles / line, volume, log scale, auto-scale toggle, crosshair legend, infinite scroll back, quick ranges.
- **Indicators**: MA/EMA (up to 5), Bollinger Bands, RSI, MACD.
- **Drawing tools**: trend line, ray, extended line, horizontal line / ray, vertical line, parallel channel, rectangle,
  Fib retracement, Fib extension, fixed-range volume profile, price range, date range, ruler, long / short position,
  text, price label, arrows. Magnet, lock, undo/redo, hide all. Full settings sheet (style / text / coordinates /
  visibility per interval) with **named templates per tool**.
- **Price alerts**: hover (desktop) or long-press (phone) the chart, tap ⊕ next to the crosshair price. Direction is set
  from where the target is relative to the last price; fires once, then disappears.
- **Phone layout** (< 640 px): full-screen chart, two floating pills (symbol/interval wheels, tools), bottom sheets,
  aim-then-place drawing, custom pinch zoom. Add to Home Screen for a full-screen app.
- **Desktop layout**: top bar, grouped left toolbar with favourites, right watchlist with groups + symbol details,
  context menus, keyboard shortcuts (type digits to change interval, letters to search, Alt+T/H/V/F tools, Ctrl+Z).

## Local development

```bash
python3.11 -m venv venv && ./venv/bin/pip install -r server/requirements.txt
cd web && npm ci && npm run build && cd ..
cd server && ../venv/bin/python -u -m uvicorn app:app --host 127.0.0.1 --port 8510
# frontend hot reload: cd web && npm run dev   (http://127.0.0.1:5173, proxies /api and /ws to 8510)
```

## Layout

```
server/app.py            FastAPI: /api/config /api/bars /api/search /api/quotes /api/alerts /api/drawings /api/state/*, /ws/kline, static files, optional Basic auth
server/data_sources.py   market data sources, bar loading / back-fill, background sync, symbol lists
server/store.py          SQLite bar store
server/alerts.py         built-in price alerts (SQLite + monitor thread + Telegram / webhook)
server/logos.py          symbol icons (LOGO_SOURCE)
web/src/chart/           ChartPane (chart, indicators, legend, alerts, live updates), indicators.ts
web/src/draw/            layer.ts (canvas rendering, hit-testing), controller.ts (mouse / touch, undo)
web/src/ui/              desktop.tsx, mobile.tsx, panels.tsx, drawSettings.tsx, alerts.tsx, icons.tsx
```

## Known limits

- Yahoo stock data is delayed intraday; 1m bars only cover 7 days, 5–30m 60 days, 1h about 2 years. Daily bars are
  split-adjusted, not dividend-adjusted, and Yahoo's split history has occasional errors.
- TWSE MIS is an unofficial endpoint giving last price only.
- Drawings are saved per symbol as whole-file overwrites (last writer wins), max 400 per symbol.
- Single user: there are no per-user accounts; everyone who can log in shares drawings, watchlist and alerts.

## License

MIT — see `LICENSE`. Third-party notices in `NOTICE`.
