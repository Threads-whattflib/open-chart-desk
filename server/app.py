"""open-chart-desk 後端：K 線 / 搜尋 / 報價 API、加密貨幣即時 K 線 WebSocket 轉接、畫線與自選清單存檔、價格提醒。

啟動：python -u -m uvicorn app:app --host 0.0.0.0 --port 8510   （在 server/ 目錄下）
前端只跟這支後端要資料，不在瀏覽器直接打交易所。設定全部走環境變數，見 repo 根目錄的 .env.example。
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import alerts
import data_sources as ds
import logos
import store

# Windows（cp950 等）主控台印到編碼外的字元會直接丟例外把程式弄掛，改成印不出來就用 ? 代替
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("CHART_DESK_DATA", ROOT / "data"))
DIST = ROOT / "web" / "dist"
MAX_DRAWINGS = 400
STATE_KEYS = {"watchlist", "settings"}

app = FastAPI(title="open-chart-desk", docs_url=None, redoc_url=None)
ds.warm_up()
store.init(DATA_DIR / "bars.db")
alerts.init(DATA_DIR / "alerts.db")
import threading  # noqa: E402
threading.Thread(target=ds.sync_loop, daemon=True, name="bar-sync").start()


# ── 存取密碼（選用）：設了 AUTH_PASSWORD 就整站要 HTTP Basic 登入（含 WebSocket）。沒設＝不鎖，只適合自己的區網 ──
AUTH_USER = os.environ.get("AUTH_USER", "admin")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
# Safari 連 WebSocket 時不一定會帶 Basic 帳密，所以登入成功的 HTTP 回應順便發一個 cookie，WebSocket 認這個 cookie。
# 值由帳密算出來（換密碼就失效），HttpOnly + SameSite=Strict
AUTH_COOKIE = "ocd_auth"
_COOKIE_VAL = hmac.new(AUTH_PASSWORD.encode(), f"ws:{AUTH_USER}".encode(), "sha256").hexdigest().encode()


def _basic_ok(headers: dict[bytes, bytes]) -> bool:
    raw = headers.get(b"authorization", b"").decode("latin-1")
    if not raw.lower().startswith("basic "):
        return False
    try:
        user, _, pw = base64.b64decode(raw[6:]).partition(b":")
    except Exception:
        return False
    # 比 bytes：compare_digest 比 str 時遇到非 ASCII（中文密碼）會丟 TypeError
    return hmac.compare_digest(user, AUTH_USER.encode()) & hmac.compare_digest(pw, AUTH_PASSWORD.encode())


def _cookie_ok(headers: dict[bytes, bytes]) -> bool:
    for part in headers.get(b"cookie", b"").split(b";"):
        k, _, v = part.strip().partition(b"=")
        if k == AUTH_COOKIE.encode():
            return hmac.compare_digest(v, _COOKIE_VAL)
    return False


class BasicAuth:
    """純 ASGI middleware：HTTP 要 Basic 帳密；WebSocket 認 Basic 帳密或登入後發的 cookie。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        if scope["type"] == "websocket":
            if _basic_ok(headers) or _cookie_ok(headers):
                return await self.app(scope, receive, send)
            return await send({"type": "websocket.close", "code": 1008})
        if _basic_ok(headers):
            if _cookie_ok(headers):
                return await self.app(scope, receive, send)
            secure = "; Secure" if scope.get("scheme") == "https" else ""
            cookie = f"{AUTH_COOKIE}={_COOKIE_VAL.decode()}; Path=/; HttpOnly; SameSite=Strict{secure}".encode()

            async def send_with_cookie(msg):
                if msg["type"] == "http.response.start":
                    msg = {**msg, "headers": [*msg.get("headers", []), (b"set-cookie", cookie)]}
                await send(msg)
            return await self.app(scope, receive, send_with_cookie)
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"www-authenticate", b'Basic realm="open-chart-desk", charset="UTF-8"'),
                                (b"content-type", b"text/plain; charset=utf-8")]})
        await send({"type": "http.response.body", "body": "需要登入".encode()})


if AUTH_PASSWORD:
    app.add_middleware(BasicAuth)
else:
    print("[WARN] 沒設 AUTH_PASSWORD：任何連得到這個 port 的人都能看圖、改畫線和提醒。不要直接開到公開網路。", flush=True)


def _check(market: str, symbol: str, iv: str | None = None) -> None:
    if not ds.valid_symbol(market, symbol):
        raise HTTPException(400, "代號格式不對")
    if iv is not None and iv not in ds.intervals(market):
        raise HTTPException(400, "不支援的週期")


def _read(path: Path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default
    except Exception as e:
        print(f"[ERR] 讀 {path.name} 失敗：{e}", flush=True)
        return default


def _write(path: Path, obj) -> None:
    """原子寫檔：先寫暫存檔再 replace，寫到一半斷電也不會留下壞檔。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


@app.get("/api/config")
def config():
    return {"intervals": {m: ds.intervals(m) for m in ds.MARKETS}}


@app.get("/api/search")
def search(q: str = "", m: str = "all"):
    if m not in ("all", *ds.MARKETS):
        raise HTTPException(400, "市場不對")
    return ds.search(q[:20], m)


@app.get("/api/bars")
def bars(market: str, symbol: str, iv: str, to: int | None = None, limit: int = 1000):
    _check(market, symbol, iv)
    out = ds.bars(market, symbol, iv, to, limit)
    if not out["t"] and not to:
        raise HTTPException(404, "抓不到這個商品的 K 線")
    if market == "tw":
        out["name"] = ds.tw_name(symbol)
    if market == "crypto":
        out["venue"] = ds.crypto_venue(symbol)
    return out


# 抓縮圖可能要幾十秒（官網、圖示下載、yfinance）：用自己的 4 條執行緒，排隊的請求在事件迴圈上等，
# 不佔 FastAPI 共用的執行緒池，清單一次冒出很多沒快取的縮圖時 K 線 / 報價 API 才不會跟著卡住
_LOGO_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="logo")


@app.get("/api/logo")
async def logo(market: str, symbol: str):
    _check(market, symbol)
    loop = asyncio.get_running_loop()
    path = await loop.run_in_executor(
        _LOGO_POOL, lambda: logos.logo(market, symbol, ds.tw_name(symbol) if market == "tw" else ""))
    if not path:
        raise HTTPException(404)
    # SVG 是外部來的：直接開網址時也不准跑腳本、不准載外部資源（只允許內嵌的 data: 圖）
    return FileResponse(path, media_type="image/svg+xml", headers={
        "Cache-Control": "public, max-age=604800",
        "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'"})


@app.get("/api/store")
def store_stats():
    return store.stats()


@app.get("/api/quotes")
def quotes(items: str = ""):
    pairs = []
    for it in items.split(",")[:60]:
        m, _, s = it.partition(":")
        if ds.valid_symbol(m, s):
            pairs.append((m, s))
    return ds.quotes(pairs)


@app.get("/api/alerts")
def alerts_list(market: str, symbol: str):
    _check(market, symbol)
    return JSONResponse(alerts.list_for(market, symbol), headers={"Cache-Control": "no-store"})


@app.post("/api/alerts")
def alerts_create(body: dict = Body(...)):
    market, symbol = str(body.get("market", "")), str(body.get("symbol", ""))
    _check(market, symbol)
    try:
        price, last = float(body["price"]), float(body["last"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "價格格式不對")
    if not (price > 0 and last > 0):
        raise HTTPException(400, "價格要大於 0")
    return alerts.create(market, symbol, price, last, str(body.get("note", "")))


@app.post("/api/alerts/test")
def alerts_test():
    return alerts.send_test()


@app.delete("/api/alerts/{aid}")
def alerts_delete(aid: int):
    alerts.delete(aid)
    return {"ok": True}


def _drawing_file(market: str, symbol: str) -> Path:
    return DATA_DIR / "drawings" / f"{market}_{symbol.replace('^', '_')}.json"


@app.get("/api/drawings")
def get_drawings(market: str, symbol: str):
    _check(market, symbol)
    return _read(_drawing_file(market, symbol), [])


@app.put("/api/drawings")
def put_drawings(market: str, symbol: str, items: list[dict] = Body(...)):
    _check(market, symbol)
    if len(items) > MAX_DRAWINGS:
        raise HTTPException(400, f"每個商品最多 {MAX_DRAWINGS} 個圖形")
    _write(_drawing_file(market, symbol), items)
    return {"ok": True, "n": len(items)}


# state 是開頁面第一個要等的請求：用 async（小 JSON 檔，在事件迴圈上讀寫很快），
# 不跟 bars 等慢的同步請求搶執行緒池。冷快取時快速切換商品會塞滿執行緒池，同步版要排隊近 10 秒，頁面卡在「載入中」
@app.get("/api/state/{key}")
async def get_state(key: str):
    if key not in STATE_KEYS:
        raise HTTPException(404)
    return JSONResponse(_read(DATA_DIR / f"{key}.json", None))


@app.put("/api/state/{key}")
async def put_state(key: str, value=Body(...)):
    if key not in STATE_KEYS:
        raise HTTPException(404)
    if len(json.dumps(value)) > 200_000:
        raise HTTPException(400, "資料太大")
    _write(DATA_DIR / f"{key}.json", value)
    return {"ok": True}


# ── 加密貨幣即時 K 線：轉接 Binance WebSocket；連不上或該代號只在 Bybit 時改每 2 秒輪詢 REST ──
async def _upstream_binance(ws: WebSocket, symbol: str, iv: str) -> None:
    import websockets   # uvicorn[standard] 會帶；沒有就走輪詢

    url = f"wss://stream.binance.com:9443/ws/{symbol.lower()}@kline_{iv}"
    async with websockets.connect(url, open_timeout=8, ping_interval=20) as up:
        async for msg in up:
            k = json.loads(msg).get("k")
            if k:
                await ws.send_json({"t": k["t"] // 1000, "o": float(k["o"]), "h": float(k["h"]), "l": float(k["l"]),
                                    "c": float(k["c"]), "v": float(k["v"])})


async def _upstream_poll(ws: WebSocket, symbol: str, iv: str) -> None:
    while True:
        rows = await asyncio.to_thread(ds.crypto_rows, symbol, iv, None, 2)
        for r in rows:
            await ws.send_json(dict(zip("tohlcv", r)))
        await asyncio.sleep(2)


@app.websocket("/ws/kline")
async def ws_kline(ws: WebSocket, symbol: str, iv: str):
    await ws.accept()
    if not ds.valid_symbol("crypto", symbol) or iv not in ds.CRYPTO_IVS:
        await ws.close(code=1008)
        return

    async def pump():
        if ds.crypto_venue(symbol) == "binance":
            try:
                await _upstream_binance(ws, symbol, iv)
            except (WebSocketDisconnect, asyncio.CancelledError):
                raise
            except Exception as e:
                print(f"[WARN] binance ws {symbol} {iv}：{e}；改輪詢", flush=True)
        await _upstream_poll(ws, symbol, iv)

    async def watch_client():   # 前端關掉連線時結束
        while True:
            await ws.receive_text()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(watch_client())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


# ── 前端靜態檔 ──────────────────────────────────────────────────────────────
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = (DIST / path).resolve()
        if path and f.is_file() and DIST.resolve() in f.parents:
            return FileResponse(f)
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
