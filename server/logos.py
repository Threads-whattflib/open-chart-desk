"""台股 / 美股 / 加密商品縮圖，存在 data/logos/。

來源由環境變數 LOGO_SOURCE 決定：
  favicon（預設）     只用公司官網圖示（下面的「退路」）
  tradingview        先用 TradingView 的 logo，查不到再用官網圖示。這是非官方介面，可能違反 TradingView
                     的使用條款，要不要開請自行判斷；開了之後責任在架站的人
  none               不抓任何圖，前端一律顯示代號色塊（加密貨幣仍用內建的 CC0 幣種圖）

LOGO_SOURCE=tradingview 時的第一順位：TradingView 的 logo（和 TradingView 看到的一樣，滿版方形 SVG、品牌色當底）。
  用它的商品搜尋（symbol-search.tradingview.com，非官方介面）查代號的 logoid，再下載
  s3-symbol-logo.tradingview.com/<logoid>--big.svg。每檔只查一次，存成 card_<市場>_<代號>.svg。

退路：TradingView 查不到時用公司官網圖示，墊白底包成同樣的方形 SVG（cardf_…，7 天後再試一次 TradingView）。
  官網：台股用公開資訊觀測站登記的網址；美股用 Yahoo 的公司資料（yfinance info.website）。
  候選：官網首頁宣告的 apple-touch-icon 與其他 icon、/apple-touch-icon.png、Google 的網站圖示服務；
  逐一下載量實際像素，取最大的（SVG 直接採用）；ICO 轉成 PNG。原圖存 <市場>_<代號>.<副檔名>。
  ETF 沒有公司官網：台股用名稱開頭對到投信官網，美股用發行商（fundFamily）對到發行商官網。

指數、期貨不抓。都抓不到就記 .none 標記，7 天後再試；前端拿不到圖時退回代號色塊。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import base64
import io

import requests
from PIL import Image

# 跟 app.py 用同一個資料夾（CHART_DESK_DATA），換位置時縮圖快取才會跟著進 volume
DATA_DIR = Path(os.environ.get("CHART_DESK_DATA", Path(__file__).resolve().parent.parent / "data"))
LOGO_DIR = DATA_DIR / "logos"
SITES_FILE = DATA_DIR / "cache" / "tw_sites.json"
UA = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"}
MAX_BYTES = 400_000
EXT = {"image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg",
       "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
_locks: dict[str, threading.Lock] = {}
_glock = threading.Lock()


def _log(msg: str) -> None:
    print(f"[logos] {msg}", flush=True)


def _sites() -> dict[str, str]:
    """台股代號 → 公司官網（上市 + 上櫃），7 天更新一次。"""
    if SITES_FILE.exists() and time.time() - SITES_FILE.stat().st_mtime < 7 * 86400:
        return json.loads(SITES_FILE.read_text("utf-8"))
    out: dict[str, str] = {}
    try:
        for x in requests.get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", headers=UA, timeout=25).json():
            if x.get("網址"):
                out[x["公司代號"]] = x["網址"].strip()
    except Exception as e:
        _log(f"[WARN] 上市公司網址: {e}")
    try:
        for x in requests.get("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O", headers=UA, timeout=25).json():
            if x.get("WebAddress"):
                out[x["SecuritiesCompanyCode"]] = x["WebAddress"].strip()
    except Exception as e:
        _log(f"[WARN] 上櫃公司網址: {e}")
    if len(out) > 500:
        SITES_FILE.parent.mkdir(parents=True, exist_ok=True)
        SITES_FILE.write_text(json.dumps(out, ensure_ascii=False), "utf-8")
        return out
    return json.loads(SITES_FILE.read_text("utf-8")) if SITES_FILE.exists() else out


class _Icons(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found: list[tuple[int, str]] = []   # (優先分數, href)

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel, href = a.get("rel", "").lower(), a.get("href", "")
        if not href or "icon" not in rel or "mask" in rel:
            return
        size = max([int(n) for n in re.findall(r"(\d+)x\d+", a.get("sizes", ""))] or [0])
        self.found.append(((1000 if "apple-touch" in rel else 0) + size, href))


# ETF 名稱開頭 → 投信官網
ISSUERS = {
    "元大": "www.yuantaetfs.com", "國泰": "www.cathaysite.com.tw", "富邦": "websys.fsit.com.tw", "群益": "www.capitalfund.com.tw",
    "復華": "www.fhtrust.com.tw", "中信": "www.ctbcinvestments.com", "統一": "www.ezmoney.com.tw", "永豐": "sitc.sinopac.com",
    "凱基": "www.kgifund.com.tw", "新光": "www.skit.com.tw", "第一金": "www.fsitc.com.tw", "野村": "www.nomurafunds.com.tw",
    "台新": "www.tsit.com.tw", "兆豐": "www.megafunds.com.tw", "大華": "www.dwsitc.com.tw", "華南永昌": "www.hnitc.com.tw",
}


def _get_image(url: str) -> tuple[bytes, str, int] | None:
    """下載並量大小：(檔案內容, 副檔名, 邊長像素)。SVG 的邊長記成 10000（向量圖，放多大都清楚）。"""
    try:
        r = requests.get(url, headers=UA, timeout=8, stream=True)
        if r.status_code != 200:
            return None
        ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
        data = r.raw.read(MAX_BYTES + 1, decode_content=True)
        if not 200 < len(data) <= MAX_BYTES:
            return None
        if ctype == "image/svg+xml" or data.lstrip()[:5] in (b"<svg ", b"<?xml"):
            return data, "svg", 10000
        im = Image.open(io.BytesIO(data))
        if im.format == "ICO":                           # ICO 裡有多種尺寸：取最大那張轉成 PNG
            big = max(im.ico.sizes(), key=lambda wh: wh[0] * wh[1])
            im.size = big
            im.load()
            buf = io.BytesIO()
            im.save(buf, "PNG")
            return buf.getvalue(), "png", min(big)
        fmt = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "WEBP": "webp"}.get(im.format or "", EXT.get(ctype, "png"))
        return data, fmt, min(im.size)
    except Exception:
        return None


def _fetch(site: str) -> tuple[bytes, str] | None:
    home = site if site.startswith(("http://", "https://")) else f"https://{site}"
    if urlparse(home).scheme not in ("http", "https"):
        return None
    cands: list[str] = []
    try:
        r = requests.get(home, headers=UA, timeout=10)
        if r.ok:
            p = _Icons()
            p.feed(r.text[:300_000])
            cands += [urljoin(r.url, h) for _, h in sorted(p.found, reverse=True)]
            home = r.url
    except Exception as e:
        _log(f"[WARN] {home}: {type(e).__name__}")
    host = urlparse(home).netloc
    cands += [f"https://{host}/apple-touch-icon.png", f"https://www.google.com/s2/favicons?domain={host}&sz=128"]
    best: tuple[bytes, str, int] | None = None
    for u in list(dict.fromkeys(cands))[:8]:
        img = _get_image(u)
        if img and (best is None or img[2] > best[2]):
            best = img
        if best and best[2] >= 120:                      # 夠大了，不用再試
            break
    return (best[0], best[1]) if best else None


# 美股 ETF 發行商（yfinance fundFamily / 名稱裡的字，小寫）→ 官網
US_ISSUERS = {
    "state street": "www.ssga.com", "spdr": "www.ssga.com", "ishares": "www.ishares.com", "blackrock": "www.ishares.com",
    "invesco": "www.invesco.com", "proshares": "www.proshares.com", "direxion": "www.direxion.com",
    "vanguard": "investor.vanguard.com", "schwab": "www.schwabassetmanagement.com", "global x": "www.globalxetfs.com",
    "vaneck": "www.vaneck.com", "ark etf": "www.ark-funds.com", "graniteshares": "graniteshares.com",
    "jpmorgan": "am.jpmorgan.com", "first trust": "www.ftportfolios.com", "tradr": "www.tradretfs.com",
    "defiance": "www.defianceetfs.com", "roundhill": "www.roundhillinvestments.com", "yieldmax": "www.yieldmaxetfs.com",
    "wisdomtree": "www.wisdomtree.com", "fidelity": "www.fidelity.com", "amplify": "amplifyetfs.com",
    "select sector": "www.sectorspdrs.com",
}


def _us_site(symbol: str) -> str | None:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
    except Exception as e:
        _log(f"[WARN] us {symbol} 公司資料: {type(e).__name__}")
        return None
    if info.get("website"):
        return info["website"]
    fam = f"{info.get('fundFamily') or ''} {info.get('longName') or ''} ".lower()
    return next((v for k, v in US_ISSUERS.items() if k in fam), None)


TV_SEARCH = "https://symbol-search.tradingview.com/symbol_search/v3/"
TV_LOGO = "https://s3-symbol-logo.tradingview.com/{}--big.svg"
TV_HDR = {**UA, "Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/"}
TV_EXCH = {"tw": {"TWSE", "TPEX"}, "us": {"NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "ARCA", "CBOE", "BATS"}, "crypto": {"BINANCE"}}
WEEK = 7 * 86400
SOURCE = os.environ.get("LOGO_SOURCE", "favicon").strip().lower()
# Yahoo 的指數 / 期貨代號 → TradingView 搜尋用的代號 + 交易所（logoid 已逐一查過是對的圖，不是公司或國旗）
TV_ALIAS = {
    "^VIX": ("VIX", "CBOE"), "^KS11": ("KOSPI", "KRX"), "DX-Y.NYB": ("DXY", "TVC"),
    "GC=F": ("GC", "COMEX"), "SI=F": ("SI", "COMEX"), "CL=F": ("CL", "NYMEX"),
    "NQ=F": ("NQ", "CME"), "ES=F": ("ES", "CME"),
    "^GSPC": ("SPX", "SP"), "^IXIC": ("IXIC", "NASDAQ"), "^DJI": ("DJI", "DJ"), "^SOX": ("SOX", "NASDAQ"),
    "^TWII": ("TAIEX", "INDEX"), "^N225": ("NI225", "TVC"), "^HSI": ("HSI", "HKEX"),
}


def _tv(market: str, symbol: str) -> bytes | None:
    alias = TV_ALIAS.get(symbol) if market == "us" else None
    q = alias[0] if alias else symbol.replace("-", ".") if market == "us" else symbol   # Yahoo 的 BRK-B = TradingView 的 BRK.B
    params = {"text": q, "hl": 0, "lang": "en", "domain": "production"}
    if market == "crypto":                                          # 加密：查幣安的現貨交易對，logo 是幣種圖（crypto/XTVC…）
        params |= {"exchange": "BINANCE", "search_type": "crypto"}
    try:
        r = requests.get(TV_SEARCH, params=params, headers=TV_HDR, timeout=10)
        hits = r.json().get("symbols", []) if r.ok else []
    except Exception as e:
        _log(f"[WARN] tradingview 搜尋 {market}:{symbol}: {type(e).__name__}")
        return None
    # logoid 放的位置不一：股票在 logoid，加密在 logo.logoid（交易對 ETHBTC 這種是 logo.logoid1 = 前面那個幣）
    def lid_of(h: dict) -> str | None:
        lg = h.get("logo") or {}
        return h.get("logoid") or lg.get("logoid") or lg.get("logoid1") or h.get("base-currency-logoid")
    lid = next((lid_of(h) for h in hits
                if lid_of(h) and h.get("symbol") == q
                and str(h.get("exchange", "")).upper() in ({alias[1]} if alias else TV_EXCH[market])), None)
    if not lid or not re.fullmatch(r"[A-Za-z0-9/._-]+", lid):
        return None
    img = _get_image(TV_LOGO.format(lid))
    return img[0] if img and img[1] == "svg" else None


def _favicon(market: str, symbol: str, name: str) -> Path | None:
    """公司官網圖示原圖（舊做法，當退路）。"""
    key = f"{market}_{symbol}"
    for f in LOGO_DIR.glob(f"{key}.*"):
        if f.suffix != ".none":
            return f
        if time.time() - f.stat().st_mtime < WEEK:
            return None
        f.unlink(missing_ok=True)
    if market == "tw":
        site = _sites().get(symbol) or next((v for k, v in ISSUERS.items() if name.startswith(k)), None)
    else:
        site = _us_site(symbol)
    img = _fetch(site) if site else None
    if not img:
        (LOGO_DIR / f"{key}.none").touch()
        return None
    path = LOGO_DIR / f"{key}.{img[1]}"
    path.write_bytes(img[0])
    return path


def _card(raw: Path) -> bytes:
    """官網圖示墊白底、置中，包成跟 TradingView 一樣的滿版方形 SVG。只有 16px 的小圖示放小一點，放大會糊。"""
    data, ext = raw.read_bytes(), raw.suffix[1:]
    px = 10000 if ext == "svg" else min(Image.open(io.BytesIO(data)).size)
    mime = {"svg": "image/svg+xml", "jpg": "image/jpeg", "ico": "image/x-icon"}.get(ext, f"image/{ext}")
    pad = 26 if px < 40 else 15
    w = 100 - 2 * pad
    b64 = base64.b64encode(data).decode()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/>'
            f'<image x="{pad}" y="{pad}" width="{w}" height="{w}" href="data:{mime};base64,{b64}"/></svg>').encode()


def cached(market: str, symbol: str) -> bool:
    return any((LOGO_DIR / f"{p}_{market}_{symbol}.{x}").exists() for p in ("card", "cardf") for x in ("svg", "none"))


def logo(market: str, symbol: str, name: str = "") -> Path | None:
    """回傳方形 SVG 縮圖路徑；沒有就去抓（同一檔同時只抓一次）。支援台股、美股個股 / ETF、幣安交易對。"""
    if SOURCE == "none":
        return None
    if market not in ("tw", "us", "crypto") or (market == "us" and ("^" in symbol or "=" in symbol) and symbol not in TV_ALIAS):
        return None
    key = f"{market}_{symbol}"
    with _glock:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        tv, fb, miss = (LOGO_DIR / f"card_{key}.svg", LOGO_DIR / f"cardf_{key}.svg", LOGO_DIR / f"card_{key}.none")
        if tv.exists():
            return tv
        for f in (fb, miss):                         # 退路圖、查無標記：7 天內直接用，過期就重查 TradingView
            if f.exists():
                if time.time() - f.stat().st_mtime < WEEK:
                    return fb if f is fb else None
                f.unlink(missing_ok=True)
        LOGO_DIR.mkdir(parents=True, exist_ok=True)
        data = _tv(market, symbol) if SOURCE == "tradingview" else None
        if data:
            tv.write_bytes(data)
            return tv
        raw = _favicon(market, symbol, name) if market != "crypto" else None   # 加密沒有官網退路，前端改用內建幣種圖
        if raw:
            try:
                fb.write_bytes(_card(raw))
                return fb
            except Exception as e:
                _log(f"[WARN] {key} 包圖失敗: {type(e).__name__}")
        miss.touch()
        return None
