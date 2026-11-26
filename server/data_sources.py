"""行情資料：K 線、商品搜尋、報價。

加密貨幣 = Binance 現貨公開 REST（失敗改 Bybit spot → linear）；美股 / 台股 = Yahoo（yfinance）。
時間一律 UTC 秒：盤中 K 用實際開盤時刻，日 K 以上用該交易日的 UTC 午夜（日期標籤才不會差一天）。
週 K / 月 K（股票）由日 K 自己合成，不用 Yahoo 的 1wk / 1mo（最後一根常重複或日期錯位）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import logos
import store

try:
    import yfinance as yf
except Exception as e:  # pragma: no cover - 沒裝 yfinance 時股票功能停用
    print(f"[WARN] yfinance 無法載入：{e}")
    yf = None

# 跟 app.py 用同一個資料夾（CHART_DESK_DATA）：觀察清單預先同步讀的 watchlist.json / settings.json 也在這裡
DATA_DIR = Path(os.environ.get("CHART_DESK_DATA", Path(__file__).resolve().parent.parent / "data"))
CACHE_DIR = DATA_DIR / "cache"

BINANCE = "https://api.binance.com"
BYBIT = "https://api.bybit.com"
UA = {"User-Agent": "Mozilla/5.0 (chart-client)"}

MARKETS = ("crypto", "tw", "us")
CRYPTO_IVS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"]
STOCK_IVS = ["1m", "5m", "15m", "30m", "1h", "1d", "1w", "1M"]
BYBIT_IV = {"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120",
            "4h": "240", "1d": "D", "1w": "W", "1M": "M"}
# Yahoo 盤中資料只給最近一段：1 分 K 7 天、5~30 分 K 60 天、小時 K 730 天
YF_IV = {"1m": ("1m", "7d"), "5m": ("5m", "60d"), "15m": ("15m", "60d"), "30m": ("30m", "60d"),
         "1h": ("60m", "730d"), "1d": ("1d", "max")}

SYM_RE = {
    "crypto": re.compile(r"^[A-Z0-9]{3,20}$"),
    "tw": re.compile(r"^[0-9][0-9A-Z]{3,5}$"),
    "us": re.compile(r"^\^?[A-Z][A-Z0-9.\-=]{0,9}$"),   # = 給期貨（GC=F 黃金、CL=F 原油），^ 給指數（^KS11）
}

_S = requests.Session()
_S.headers.update(UA)
_lock = threading.Lock()
_cache: dict[tuple, tuple[float, object]] = {}
_venue: dict[str, str] = {}        # 加密代號 → binance / bybit:spot / bybit:linear
_yf_ticker: dict[tuple[str, str], str] = {}   # (market, symbol) → Yahoo 代號


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)


def _cached(key: tuple, ttl: float, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    if val is not None:
        with _lock:
            _cache[key] = (now, val)
            if len(_cache) > 600:   # 只留最新的一批，避免長時間跑下來無限長大
                for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:200]:
                    _cache.pop(k, None)
    return val


def valid_symbol(market: str, symbol: str) -> bool:
    return market in SYM_RE and bool(SYM_RE[market].match(symbol))


def intervals(market: str) -> list[str]:
    return CRYPTO_IVS if market == "crypto" else STOCK_IVS


# ── 加密貨幣 ────────────────────────────────────────────────────────────────
def _binance_klines(sym: str, iv: str, end_ms: int | None, limit: int) -> list[list]:
    p = {"symbol": sym, "interval": iv, "limit": limit}
    if end_ms:
        p["endTime"] = end_ms
    r = _S.get(f"{BINANCE}/api/v3/klines", params=p, timeout=8)
    if not r.ok:
        return []
    return [[k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in r.json()]


def _bybit_klines(sym: str, iv: str, end_ms: int | None, limit: int, cat: str) -> list[list]:
    p = {"category": cat, "symbol": sym, "interval": BYBIT_IV[iv], "limit": limit}
    if end_ms:
        p["end"] = end_ms
    r = _S.get(f"{BYBIT}/v5/market/kline", params=p, timeout=8)
    lst = r.json().get("result", {}).get("list", []) if r.ok else []
    return [[int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
            for k in reversed(lst)]   # Bybit 回傳新到舊


def crypto_rows(sym: str, iv: str, end_ms: int | None = None, limit: int = 1000) -> list[list]:
    order = ["binance", "bybit:spot", "bybit:linear"]
    known = _venue.get(sym)
    if known:
        order = [known] + [v for v in order if v != known]
    for v in order:
        try:
            rows = (_binance_klines(sym, iv, end_ms, limit) if v == "binance"
                    else _bybit_klines(sym, iv, end_ms, limit, v.split(":")[1]))
        except Exception as e:
            _log(f"[WARN] {v} {sym} {iv}: {e}")
            rows = []
        if rows:
            _venue[sym] = v
            return rows
    return []


def crypto_venue(sym: str) -> str:
    return _venue.get(sym, "binance")


# ── 股票（Yahoo）────────────────────────────────────────────────────────────
def _yf_candidates(market: str, sym: str) -> list[str]:
    known = _yf_ticker.get((market, sym))
    if known:
        return [known]
    return [f"{sym}.TW", f"{sym}.TWO"] if market == "tw" else [sym]


def _yf_rows(market: str, sym: str, yiv: str, period: str, prepost: bool = False) -> list[list]:
    if yf is None:
        return []
    daily = yiv == "1d"
    for t in _yf_candidates(market, sym):
        try:
            h = yf.Ticker(t).history(period=period, interval=yiv, auto_adjust=False, prepost=prepost)
        except Exception as e:
            _log(f"[WARN] yfinance {t} {yiv}: {e}")
            continue
        if h is None or not len(h):
            continue
        h = h.dropna(subset=["Open", "High", "Low", "Close"])
        rows: list[list] = []
        last_t = 0
        for i, r in h.iterrows():
            ts = (int(datetime(i.year, i.month, i.day, tzinfo=timezone.utc).timestamp()) if daily
                  else int(i.timestamp()))
            if ts <= last_t:
                continue
            last_t = ts
            rows.append([ts, round(float(r.Open), 6), round(float(r.High), 6), round(float(r.Low), 6),
                         round(float(r.Close), 6), float(r.Volume or 0)])
        if rows:
            _yf_ticker[(market, sym)] = t
            return rows
    return []


def _group(rows: list[list], key) -> list[list]:
    """把日 K 合成週 K / 月 K；key(date) 回傳該根 K 棒的起始日。"""
    out: list[list] = []
    cur = None
    for t, o, h, l, c, v in rows:
        d = datetime.fromtimestamp(t, timezone.utc).date()
        k = int(datetime.combine(key(d), datetime.min.time(), timezone.utc).timestamp())
        if cur is None or cur[0] != k:
            cur = [k, o, h, l, c, v]
            out.append(cur)
        else:
            cur[2] = max(cur[2], h)
            cur[3] = min(cur[3], l)
            cur[4] = c
            cur[5] += v
    return out


# ── 對外：K 線（先讀本地資料庫 data/bars.db，外部來源只補尾巴；見 store.py）────────────
IV_SEC = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
          "1d": 86400, "1w": 604800, "1M": 2592000}
_key_locks: dict[tuple, threading.Lock] = {}
_inflight: set[tuple] = set()


def _storage_iv(market: str, iv: str) -> str:
    """股票的週 K / 月 K 由日 K 合成，所以只存日 K。"""
    return "1d" if market != "crypto" and iv in ("1w", "1M") else iv


def _ttl(market: str, iv: str) -> int:
    """距離上次向外部補資料超過這麼久，才再問一次外部。"""
    if market == "crypto":
        return 10
    return 20 if IV_SEC[iv] < 86400 else 60


def _key_lock(key: tuple) -> threading.Lock:
    with _lock:
        return _key_locks.setdefault(key, threading.Lock())


def _prepost(market: str, sym: str, iv: str) -> bool:
    """美股個股 / ETF 的盤中 K 含盤前盤後（美東 04:00–20:00）；日 K、期貨、指數不含。"""
    return market == "us" and iv != "1d" and _plain_us(sym)


def _plain_us(sym: str) -> bool:
    return "=" not in sym and not sym.startswith("^")


def _full(market: str, sym: str, iv: str) -> list[list]:
    if market == "crypto":
        return crypto_rows(sym, iv, None, 1000)
    yiv, period = YF_IV[iv]
    return _yf_rows(market, sym, yiv, period, _prepost(market, sym, iv))


def refresh(market: str, sym: str, iv: str) -> None:
    """把一組 K 線補到最新：資料庫沒有就整批抓；有就只抓最後一小段。iv 是存放用的週期。"""
    key = (market, sym, iv)
    with _key_lock(key):
        m = store.meta(market, sym, iv)
        if m and time.time() - m["synced"] < 2:          # 別的請求剛補過
            return
        last = store.read(market, sym, iv, None, 1)
        if not m or not last:
            rows = _full(market, sym, iv)
            if rows:
                store.write(market, sym, iv, rows, replace_all=True)
                store.mark(market, sym, iv, synced=True, complete=market != "crypto" or len(rows) < 1000)
            return
        last_t = last[-1][0]
        if market == "crypto":
            n = int((time.time() - last_t) / IV_SEC[iv]) + 3
            if n > 900:                                  # 太久沒補，中間會有洞：整批重抓
                rows = crypto_rows(sym, iv, None, 1000)
                if rows:
                    store.write(market, sym, iv, rows, replace_all=True)
                    store.mark(market, sym, iv, synced=True, complete=len(rows) < 1000)
                return
            store.write(market, sym, iv, crypto_rows(sym, iv, None, n))
            store.mark(market, sym, iv, synced=True)
            return
        # 股票：抓最近一段，跟資料庫重疊的部分比收盤價；對不上代表分割調整改寫了歷史，整組重抓
        rows = _yf_rows(market, sym, YF_IV[iv][0], "1mo" if iv == "1d" else "5d", _prepost(market, sym, iv))
        if not rows:
            return
        old = {r[0]: r[4] for r in store.read(market, sym, iv, rows[-1][0] + 1, len(rows) + 5)[:-1]}
        bad = any(t in old and c and abs(old[t] - c) / c > 0.005 for t, _, _, _, c, _ in rows)
        if bad:
            _log(f"[WARN] {market} {sym} {iv} 歷史價格被改寫（分割調整），整組重抓")
            full = _full(market, sym, iv)
            if not full:                                 # 重抓失敗（被擋、斷線）：舊資料先留著，下次再試
                _log(f"[WARN] {market} {sym} {iv} 整組重抓失敗，保留舊資料")
                return
            store.write(market, sym, iv, full, replace_all=True)
        elif rows[0][0] > last_t:                        # 中間有洞：抓外部能給的全部補進去
            store.write(market, sym, iv, _full(market, sym, iv))
        else:
            store.write(market, sym, iv, rows)
        store.mark(market, sym, iv, synced=True)


def _refresh_bg(market: str, sym: str, iv: str) -> None:
    key = (market, sym, iv)
    with _lock:
        if key in _inflight:
            return
        _inflight.add(key)

    def run():
        try:
            refresh(market, sym, iv)
        except Exception as e:
            _log(f"[WARN] 背景補資料 {key}: {e}")
        finally:
            with _lock:
                _inflight.discard(key)
    threading.Thread(target=run, daemon=True).start()


def _ensure(market: str, sym: str, iv: str, small: bool) -> None:
    m = store.meta(market, sym, iv)
    if not m:
        refresh(market, sym, iv)
        return
    age = time.time() - m["synced"]
    if age <= _ttl(market, iv):
        return
    # 加密貨幣補尾巴很快、輪詢的小請求要拿最新的：直接補。
    # 股票打開圖表時：資料庫 10 分鐘內補過就先回資料庫的，背景再補（Yahoo 一次要一秒多）。
    if market == "crypto" or small or age > 600:
        refresh(market, sym, iv)
    else:
        _refresh_bg(market, sym, iv)


def _extend_left(sym: str, iv: str) -> None:
    """加密貨幣往左補一批（資料庫最早那根之前的 1000 根）。"""
    first = store.first_t("crypto", sym, iv)
    if first is None:
        return
    rows = crypto_rows(sym, iv, first * 1000 - 1, 1000)
    store.write("crypto", sym, iv, rows)
    # 回來 0 根分不出是「沒有更早的」還是「連線失敗」，不標完整，下次往左捲再試；
    # 真的到上市第一根時，那一批會是 1~999 根，在那時就標完整了
    if 0 < len(rows) < 1000:
        store.mark("crypto", sym, iv, complete=True)


def bars(market: str, sym: str, iv: str, to: int | None = None, limit: int = 1000) -> dict:
    """回傳 {t,o,h,l,c,v,more}。to = 只要早於這個時間（秒）的 K 棒，用來往左補歷史。"""
    limit = max(1, min(limit, 1000))
    siv = _storage_iv(market, iv)
    if to is None:
        _ensure(market, sym, siv, small=limit <= 5)
    store.mark(market, sym, siv, viewed=True)
    if market == "crypto":
        rows = store.read(market, sym, siv, to, limit)
        m = store.meta(market, sym, siv) or {"complete": True}
        if to and len(rows) < limit and not m["complete"]:
            _extend_left(sym, siv)
            rows = store.read(market, sym, siv, to, limit)
            m = store.meta(market, sym, siv) or {"complete": True}
        more = len(rows) == limit or not m["complete"]
    elif siv != iv:
        daily = store.read(market, sym, "1d", None, 200000)
        if market == "tw" and not to and (lv := tw_live([sym]).get(sym)):
            daily = _tw_patch(daily, lv, "1d")
        grouped = _group(daily, (lambda d: d - timedelta(days=d.weekday())) if iv == "1w" else (lambda d: d.replace(day=1)))
        if to:
            grouped = [r for r in grouped if r[0] < to]
        more, rows = len(grouped) > limit, grouped[-limit:]
    else:
        rows = store.read(market, sym, siv, to, limit + 1)
        more, rows = len(rows) > limit, rows[-limit:]
        if market == "tw" and not to and (lv := tw_live([sym]).get(sym)):
            rows = _tw_patch(rows, lv, siv)[-limit:]
    cols = list(zip(*rows)) if rows else [[], [], [], [], [], []]
    return {"t": list(cols[0]), "o": list(cols[1]), "h": list(cols[2]), "l": list(cols[3]),
            "c": list(cols[4]), "v": list(cols[5]), "more": more}


def _watch_targets() -> set[tuple[str, str, str]]:
    """觀察清單 × 收藏的週期（加上日 K 與上次看的週期）：背景預先存好的組合。"""
    try:
        watch = json.loads((DATA_DIR / "watchlist.json").read_text("utf-8"))
    except Exception:
        watch = []
    try:
        st = json.loads((DATA_DIR / "settings.json").read_text("utf-8"))
    except Exception:
        st = {}
    ivs = set(st.get("favIvs") or ["15m", "1h", "4h", "1d", "1w"]) | {"1d", (st.get("last") or {}).get("iv", "1d")}
    out = set()
    for w in watch if isinstance(watch, list) else []:
        m, s = w.get("market"), w.get("symbol")
        if not valid_symbol(m or "", s or ""):
            continue
        for iv in ivs:
            if iv in intervals(m):
                out.add((m, s, _storage_iv(m, iv)))
    return out


def sync_loop() -> None:
    """背景執行緒：觀察清單的商品預先存進資料庫，最近三天看過的組合定期補到最新。"""
    time.sleep(5)
    while True:
        try:
            now, todo = time.time(), []
            for m, s, iv in _watch_targets():       # 觀察清單：沒存過就整批抓，存過的照週期定期補
                meta = store.meta(m, s, iv)
                if meta is None or now - meta["synced"] > min(max(IV_SEC[iv], 120), 1800):
                    todo.append((m, s, iv))
            for m, s, iv, synced in store.recent(3 * 86400):
                if now - synced > min(max(IV_SEC[iv], 120), 1800):
                    todo.append((m, s, iv))
            for m, s, iv in list(dict.fromkeys(todo))[:40]:
                refresh(m, s, iv)
                time.sleep(0.5 if m == "crypto" else 1.5)   # 別一次打太兇（Yahoo 會擋）
            for m, s in {(m, s) for m, s, _ in _watch_targets()}:   # 觀察清單裡的台股 / 美股：縮圖先抓好
                if m in ("tw", "us", "crypto") and not logos.cached(m, s):
                    logos.logo(m, s, tw_name(s) if m == "tw" else "")
        except Exception as e:
            _log(f"[WARN] sync_loop: {e}")
        time.sleep(60)


# ── 商品清單與搜尋 ──────────────────────────────────────────────────────────
def _crypto_list() -> list[dict]:
    def load():
        info = _S.get(f"{BINANCE}/api/v3/exchangeInfo", timeout=15).json()
        vol = {}
        try:
            for x in _S.get(f"{BINANCE}/api/v3/ticker/24hr", timeout=15).json():
                vol[x["symbol"]] = float(x.get("quoteVolume") or 0)
        except Exception as e:
            _log(f"[WARN] binance 24hr: {e}")
        out = [{"market": "crypto", "symbol": s["symbol"], "name": f'{s["baseAsset"]} / {s["quoteAsset"]}',
                "exch": "Binance", "base": s["baseAsset"]}
               for s in info.get("symbols", [])
               if s.get("status") == "TRADING" and s.get("quoteAsset") in ("USDT", "USDC", "BTC")]
        out.sort(key=lambda s: -vol.get(s["symbol"], 0))
        return out or None
    try:
        return _cached(("crypto_list",), 6 * 3600, load) or []
    except Exception as e:
        _log(f"[WARN] crypto list: {e}")
        return []


def _tw_list() -> list[dict]:
    f = CACHE_DIR / "tw_names.json"

    def load():
        out: dict[str, dict] = {}
        try:
            for x in _S.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", timeout=20).json():
                out[x["Code"]] = {"market": "tw", "symbol": x["Code"], "name": x["Name"].strip(), "exch": "上市"}
        except Exception as e:
            _log(f"[WARN] TWSE 清單: {e}")
        try:
            url = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
            for x in _S.get(url, timeout=20).json():
                code = x.get("SecuritiesCompanyCode", "")
                if code and code not in out:
                    out[code] = {"market": "tw", "symbol": code, "name": x.get("CompanyName", "").strip(),
                                 "exch": "上櫃"}
        except Exception as e:
            _log(f"[WARN] TPEx 清單: {e}")
        lst = [v for v in out.values() if SYM_RE["tw"].match(v["symbol"])]
        if len(lst) > 500:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(lst, ensure_ascii=False), "utf-8")
            return lst
        if f.exists():   # 交易所 API 抓不到時退回上次存的清單
            return json.loads(f.read_text("utf-8"))
        return None
    return _cached(("tw_list",), 24 * 3600, load) or []


def tw_name(sym: str) -> str:
    for x in _tw_list():
        if x["symbol"] == sym:
            return x["name"]
    return ""


US_DEFAULT = [("AAPL", "Apple"), ("NVDA", "NVIDIA"), ("MSFT", "Microsoft"), ("TSLA", "Tesla"), ("GOOGL", "Alphabet"),
              ("AMZN", "Amazon"), ("META", "Meta Platforms"), ("SPY", "SPDR S&P 500 ETF"),
              ("QQQ", "Invesco QQQ"), ("TQQQ", "ProShares UltraPro QQQ"), ("^GSPC", "S&P 500"),
              ("^IXIC", "NASDAQ Composite"), ("^VIX", "CBOE Volatility Index")]


def _us_search(q: str) -> list[dict]:
    def load():
        r = _S.get("https://query2.finance.yahoo.com/v1/finance/search", timeout=8,
                   params={"q": q, "quotesCount": 15, "newsCount": 0, "listsCount": 0})
        out = []
        for x in (r.json().get("quotes", []) if r.ok else []):
            s = x.get("symbol", "")
            if x.get("quoteType") in ("EQUITY", "ETF", "INDEX") and SYM_RE["us"].match(s):
                out.append({"market": "us", "symbol": s, "name": x.get("shortname") or x.get("longname") or s,
                            "exch": x.get("exchDisp") or "US"})
        return out
    try:
        return _cached(("us_search", q), 3600, load) or []
    except Exception as e:
        _log(f"[WARN] Yahoo 搜尋 {q}: {e}")
        return []


def warm_up() -> None:
    """啟動時先把商品清單抓好，第一次搜尋才不用等。"""
    def run():
        for fn in (_crypto_list, _tw_list):
            try:
                fn()
            except Exception as e:
                _log(f"[WARN] 預載清單失敗：{e}")
    threading.Thread(target=run, daemon=True).start()


def search(q: str, market: str = "all", limit: int = 40) -> list[dict]:
    q = q.strip().upper()
    out: list[dict] = []
    if market in ("all", "crypto"):
        lst = _crypto_list()
        if not q:
            stable = ("USDC", "FDUSD", "USD1", "TUSD", "RLUSD", "USDP", "DAI", "EUR", "USDE", "XUSD", "BFUSD")
            hit = [s for s in lst if s["symbol"].endswith("USDT") and s["base"] not in stable][:12]
        else:
            a = [s for s in lst if s["base"] == q]
            b = [s for s in lst if s["symbol"].startswith(q) and s not in a]
            c = [s for s in lst if q in s["symbol"] and s not in a and s not in b]
            hit = (a + b + c)[:20]
        out += [{k: v for k, v in s.items() if k != "base"} for s in hit]
    if market in ("all", "tw"):
        lst = _tw_list()
        if not q:
            want = ["2330", "0050", "2454", "2317", "00631L", "006208", "2308", "2382"]
            hit = [s for w in want for s in lst if s["symbol"] == w]
        else:
            a = [s for s in lst if s["symbol"].startswith(q)]
            b = [s for s in lst if q in s["name"].upper() and s not in a]
            a.sort(key=lambda s: (len(s["symbol"]), s["symbol"]))
            hit = (a + b)[:20]
        out += hit
    if market in ("all", "us"):
        if not q:
            out += [{"market": "us", "symbol": s, "name": n, "exch": "US"} for s, n in US_DEFAULT]
        elif re.search(r"[A-Z^]", q):
            hit = _us_search(q)
            if not any(h["symbol"] == q for h in hit) and SYM_RE["us"].match(q):
                hit.insert(0, {"market": "us", "symbol": q, "name": q, "exch": "US"})
            out += hit[:15]
    if q:   # 代號跟輸入完全一樣的排最前面（打 NVDA 要先看到美股 NVDA，不是 NVDABUSDT）
        out.sort(key=lambda s: s["symbol"] != q)
    return out[:limit]


# ── 台股即時價（證交所 MIS 基本市況報導）────────────────────────────────────────
# Yahoo 的台股有延遲；MIS 是證交所網站自己用的介面（免帳號、上市上櫃都有，約 5 秒更新一次），
# 只給「現在」的成交價 / 當日開高低 / 累積量，沒有歷史。用法：
#   - 清單報價直接換成 MIS 的價格（漲跌相對 MIS 給的昨收）。
#   - K 線回傳前把最後一根用 MIS 的價格更新（或開一根新的），不寫進資料庫；Yahoo 之後補到的照舊蓋掉。
# 非官方介面：查太密會被暫時擋 IP，所以同一批代號 5 秒內只查一次、兩次查詢至少隔 2 秒。
TPE = ZoneInfo("Asia/Taipei")
MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
_mis: dict[str, dict] = {}          # 代號 → {p, y, o, h, l, v, t, d, at}
_mis_lock = threading.Lock()
_mis_last_req = 0.0


def _num(x) -> float | None:
    try:
        v = float(x)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _mis_fetch(codes: list[str]) -> None:
    global _mis_last_req
    exch = {x["symbol"]: x["exch"] for x in _tw_list()}
    ch = []
    for c in codes:
        e = exch.get(c)
        ch += [f"tse_{c}.tw"] if e == "上市" else [f"otc_{c}.tw"] if e == "上櫃" else [f"tse_{c}.tw", f"otc_{c}.tw"]
    wait = 2 - (time.time() - _mis_last_req)
    if wait > 0:
        time.sleep(wait)
    _mis_last_req = time.time()
    r = _S.get(MIS_URL, timeout=6, params={"ex_ch": "|".join(ch), "json": 1, "delay": 0, "_": int(time.time() * 1000)})
    now = time.time()
    for x in (r.json().get("msgArray") or []) if r.ok else []:
        c, d = x.get("c", ""), x.get("d", "")
        old = _mis.get(c) or {}
        p = _num(x.get("z"))
        if p is None and old.get("d") == d:     # 這一筆快照剛好沒有成交：沿用同一天上一次的價格
            p = old.get("p")
        vol = _num(x.get("v"))
        _mis[c] = {"p": p, "y": _num(x.get("y")), "o": _num(x.get("o")), "h": _num(x.get("h")), "l": _num(x.get("l")),
                   "v": vol * 1000 if vol else None, "t": int(int(x.get("tlong") or 0) / 1000), "d": d, "at": now}
    for c in codes:                              # 沒回來的也記時間，免得一直重查
        _mis.setdefault(c, {"p": None, "at": now})["at"] = now


def tw_live(codes: list[str]) -> dict[str, dict]:
    """台股代號 → MIS 最新一筆（有成交價的才回）。"""
    codes = [c for c in dict.fromkeys(codes) if SYM_RE["tw"].match(c)]
    with _mis_lock:
        stale = [c for c in codes if time.time() - (_mis.get(c) or {}).get("at", 0) > 5]
        for i in range(0, len(stale), 40):
            try:
                _mis_fetch(stale[i:i + 40])
            except Exception as e:
                _log(f"[WARN] MIS 即時價: {e}")
                for c in stale[i:i + 40]:
                    _mis.setdefault(c, {"p": None})["at"] = time.time()
        return {c: _mis[c] for c in codes if (_mis.get(c) or {}).get("p") and _mis[c].get("d")}


def _tw_patch(rows: list[list], live: dict, iv: str) -> list[list]:
    """把 MIS 的最新價併進 K 線最後一根（或開新的一根）。rows 是由舊到新的 [t,o,h,l,c,v]。"""
    p = live["p"]
    if iv == "1d":
        d = datetime.strptime(live["d"], "%Y%m%d").replace(tzinfo=timezone.utc)
        t = int(d.timestamp())
        o, h, l, v = live.get("o") or p, max(live.get("h") or p, p), min(live.get("l") or p, p), live.get("v") or 0
        if rows and rows[-1][0] == t:
            r = rows[-1]
            rows[-1] = [t, r[1], max(r[2], h), min(r[3], l), p, max(r[5], v)]
        elif not rows or rows[-1][0] < t:
            rows.append([t, o, h, l, p, v])
        return rows
    tick = datetime.fromtimestamp(live["t"], TPE)
    hm = tick.hour * 60 + tick.minute
    if tick.weekday() >= 5 or not 9 * 60 <= hm <= 13 * 60 + 30:
        return rows
    if hm == 13 * 60 + 30:              # 13:30 收盤集合競價那一筆：併進 13:29 那根（Yahoo 不會為它開新的一根）
        tick = tick.replace(minute=29, second=59)
    ts = int(tick.timestamp())
    sec = IV_SEC[iv]
    b = ts - ts % sec
    if rows and rows[-1][0] <= ts < rows[-1][0] + sec:
        r = rows[-1]
        rows[-1] = [r[0], r[1], max(r[2], p), min(r[3], p), p, r[5]]
    elif not rows or b > rows[-1][0]:
        rows.append([b, p, p, p, p, 0])
    return rows


# ── 報價（自選清單）─────────────────────────────────────────────────────────
def _bybit_quote(sym: str) -> dict | None:
    """Binance 沒有的代號（只在 Bybit 上架的）用 Bybit ticker 報價；先試上次 K 線用的那一邊。"""
    v = _venue.get(sym, "")
    cats = [v.split(":")[1]] if v.startswith("bybit:") else []
    cats += [c for c in ("spot", "linear") if c not in cats]

    def load():
        for cat in cats:
            r = _S.get(f"{BYBIT}/v5/market/tickers", params={"category": cat, "symbol": sym}, timeout=8)
            lst = r.json().get("result", {}).get("list", []) if r.ok else []
            if lst and _num(lst[0].get("lastPrice")):
                x = lst[0]
                p, prev = float(x["lastPrice"]), _num(x.get("prevPrice24h"))
                return {"p": p, "chg": round((p / prev - 1) * 100, 2) if prev else 0.0, "a": p - prev if prev else 0.0}
        return None
    try:
        return _cached(("bq", sym), 5, load)
    except Exception as e:
        _log(f"[WARN] bybit 報價 {sym}: {e}")
        return None


def _crypto_quotes(syms: list[str]) -> dict:
    def load():
        r = _S.get(f"{BINANCE}/api/v3/ticker/24hr", timeout=8,
                   params={"symbols": json.dumps(syms, separators=(",", ":"))})
        if not r.ok:
            return None
        return {x["symbol"]: {"p": float(x["lastPrice"]), "chg": float(x["priceChangePercent"]), "a": float(x["priceChange"])} for x in r.json()}
    try:
        return _cached(("cq", tuple(syms)), 5, load) or {}
    except Exception as e:
        _log(f"[WARN] binance 報價: {e}")
        return {}


def _stock_quote(market: str, sym: str) -> dict | None:
    def load():
        rows = _yf_rows(market, sym, "1d", "5d")
        if not rows:
            return None
        last = rows[-1][4]
        prev = rows[-2][4] if len(rows) > 1 else rows[-1][1]
        return {"p": last, "chg": round((last / prev - 1) * 100, 2) if prev else 0.0, "a": last - prev if prev else 0.0}
    return _cached(("sq", market, sym), 60, load)


# ── 美股盤前 / 盤後 / 隔夜價（清單上的月亮那一行）──────────────────────────────
# 盤前 04:00–09:30、盤後 16:00–20:00（美東）：Yahoo 含盤前盤後的 1 分 K 最後一筆。
# 隔夜 20:00–04:00 與週末：Yahoo 沒有，改用 Binance 的股票代幣 bStock（<代號>BUSDT，24 小時交易）。
#   bStock 是代幣價，不是真的隔夜盤成交；跟正規盤收盤差超過 20% 就當成對錯商品（例如 BN 會撞到 BNB 幣）不用。
ET = ZoneInfo("America/New_York")


def us_session(now: datetime | None = None) -> str:
    t = (now or datetime.now(timezone.utc)).astimezone(ET)
    m, wd = t.hour * 60 + t.minute, t.weekday()
    if wd >= 5 or (wd == 4 and m >= 20 * 60):
        return "night"
    if 4 * 60 <= m < 9 * 60 + 30:
        return "pre"
    if 9 * 60 + 30 <= m < 16 * 60:
        return "regular"
    if 16 * 60 <= m < 20 * 60:
        return "post"
    return "night"


def _yahoo_ext(sym: str) -> dict | None:
    """Yahoo 含盤前盤後的最後一筆：{p, t}。"""
    def load():
        r = _S.get(f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}", timeout=8,
                   params={"range": "1d", "interval": "1m", "includePrePost": "true"})
        res = (r.json().get("chart", {}).get("result") or [None])[0] if r.ok else None
        if not res:
            return None
        ts, closes = res.get("timestamp") or [], ((res.get("indicators", {}).get("quote") or [{}])[0].get("close") or [])
        for t, c in zip(reversed(ts), reversed(closes)):
            if c:
                return {"p": round(float(c), 6), "t": int(t)}
        return None
    try:
        return _cached(("yext", sym), 60, load)
    except Exception as e:
        _log(f"[WARN] Yahoo 盤前盤後 {sym}: {e}")
        return None


def _bstock_prices(syms: list[str]) -> dict[str, float]:
    """美股代號 → bStock 價格（只查 Binance 真的有上架的）。"""
    listed = {x["symbol"] for x in _crypto_list()}
    want = sorted({f"{s}BUSDT" for s in syms} & listed)
    if not want:
        return {}

    def load():
        r = _S.get(f"{BINANCE}/api/v3/ticker/price", timeout=8, params={"symbols": json.dumps(want, separators=(",", ":"))})
        return {x["symbol"][:-5]: float(x["price"]) for x in r.json()} if r.ok else None
    try:
        return _cached(("bstock", tuple(want)), 15, load) or {}
    except Exception as e:
        _log(f"[WARN] bStock 報價: {e}")
        return {}


def _with_ext(sym: str, q: dict | None, session: str, bstock: dict[str, float]) -> dict | None:
    if not q or session == "regular" or not _plain_us(sym):
        return q
    reg, ext = q["p"], None
    if session == "night" and sym in bstock and reg and abs(bstock[sym] / reg - 1) < 0.2:
        ext = {"p": bstock[sym], "src": "token"}
    else:
        y = _yahoo_ext(sym)
        # 盤前 / 盤後要是「這一段」的成交（盤前開盤後還沒成交時，Yahoo 會回前一天盤後的最後一筆）
        start = datetime.now(ET).replace(hour=4 if session == "pre" else 16, minute=0, second=0, microsecond=0)
        if y and session in ("pre", "post") and y["t"] < start.timestamp():
            y = None
        if y and abs(y["p"] / reg - 1) < 0.5:
            ext = {"p": y["p"], "src": session if session != "night" else "post"}
    if ext and reg:
        ext["abs"] = round(ext["p"] - reg, 6)
        ext["chg"] = round((ext["p"] / reg - 1) * 100, 2)
    return {**q, "ext": ext} if ext else q


def quotes(items: list[tuple[str, str]]) -> dict:
    out: dict[str, dict | None] = {}
    crypto = sorted({s for m, s in items if m == "crypto"})
    if crypto:
        cq = _crypto_quotes(crypto)
        if not cq and len(crypto) > 1:   # 其中一個代號 Binance 沒有時整批會失敗，改逐一查
            for s in crypto:
                cq.update(_crypto_quotes([s]))
        for s in crypto:
            out[f"crypto:{s}"] = cq.get(s) or _bybit_quote(s)
    stocks = [(m, s) for m, s in items if m != "crypto"]
    if stocks:
        session = us_session()
        us = [s for m, s in stocks if m == "us" and _plain_us(s)]
        bstock = _bstock_prices(us) if session == "night" and us else {}

        live = tw_live([s for m, s in stocks if m == "tw"])

        def one(ms: tuple[str, str]) -> dict | None:
            m, s = ms
            if m == "tw" and s in live and live[s].get("y"):
                lv = live[s]
                return {"p": lv["p"], "chg": round((lv["p"] / lv["y"] - 1) * 100, 2), "a": lv["p"] - lv["y"], "src": "mis"}
            q = _stock_quote(m, s)
            return _with_ext(s, q, session, bstock) if m == "us" else q
        with ThreadPoolExecutor(max_workers=6) as ex:
            for (m, s), q in zip(stocks, ex.map(one, stocks)):
                out[f"{m}:{s}"] = q
    return out
