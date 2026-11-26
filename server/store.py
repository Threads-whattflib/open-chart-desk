"""K 線本地資料庫（SQLite，放在 data/bars.db）。

目的：打開商品時直接從本地讀，不用每次等 Yahoo / Binance。外部來源只用來補「最後幾根」。

- 每個 (市場, 代號, 週期) 一組 K 棒，主鍵 (market, symbol, iv, t)。
- 第一次看某個組合：照舊向外部抓一整批，寫進資料庫。
- 之後再看：先回資料庫裡的，同時只向外部抓最新一小段把尾巴補上（最後一根未收盤的會被覆蓋）。
- 股票的日 K 有除權息 / 分割調整，外部回傳的歷史可能整段改寫：補尾巴時若重疊的舊 K 棒價格對不上，整組重抓。
- 背景執行緒每隔一段時間把「最近被看過的組合」補到最新，所以打開時通常已經是新的。

資料庫只是快取：刪掉 data/bars.db 不會壞，下次會自己重建。
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

_local = threading.local()
_lock = threading.Lock()
_path: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars (
  market TEXT NOT NULL, symbol TEXT NOT NULL, iv TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (market, symbol, iv, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS series (
  market TEXT NOT NULL, symbol TEXT NOT NULL, iv TEXT NOT NULL,
  synced REAL NOT NULL,      -- 上次向外部補資料的時間（秒）
  viewed REAL NOT NULL,      -- 上次有人看的時間（背景補資料只補最近看過的）
  complete INTEGER NOT NULL DEFAULT 0,   -- 1 = 已經抓到外部能給的最早一根，往左不用再問外部
  PRIMARY KEY (market, symbol, iv)
);
"""


def init(path: Path) -> None:
    global _path
    path.parent.mkdir(parents=True, exist_ok=True)
    _path = path
    con = _con()
    con.executescript(SCHEMA)
    con.commit()


def _con() -> sqlite3.Connection:
    con = getattr(_local, "con", None)
    if con is None:
        assert _path is not None, "store.init() 還沒呼叫"
        con = sqlite3.connect(_path, timeout=10, check_same_thread=False)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        _local.con = con
    return con


def read(market: str, symbol: str, iv: str, to: int | None, limit: int) -> list[list]:
    """資料庫裡早於 to 的最後 limit 根（由舊到新）。"""
    q = "SELECT t,o,h,l,c,v FROM bars WHERE market=? AND symbol=? AND iv=?"
    args: list = [market, symbol, iv]
    if to:
        q += " AND t<?"
        args.append(to)
    q += " ORDER BY t DESC LIMIT ?"
    args.append(limit)
    rows = _con().execute(q, args).fetchall()
    return [list(r) for r in reversed(rows)]


def first_t(market: str, symbol: str, iv: str) -> int | None:
    r = _con().execute("SELECT MIN(t) FROM bars WHERE market=? AND symbol=? AND iv=?", (market, symbol, iv)).fetchone()
    return None if r is None or r[0] is None else int(r[0])


def write(market: str, symbol: str, iv: str, rows: list[list], replace_all: bool = False) -> None:
    if not rows and not replace_all:
        return
    with _lock:
        con = _con()
        if replace_all:
            con.execute("DELETE FROM bars WHERE market=? AND symbol=? AND iv=?", (market, symbol, iv))
        con.executemany("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?,?)",
                        [(market, symbol, iv, int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in rows])
        con.commit()


def meta(market: str, symbol: str, iv: str) -> dict | None:
    r = _con().execute("SELECT synced, viewed, complete FROM series WHERE market=? AND symbol=? AND iv=?",
                       (market, symbol, iv)).fetchone()
    return None if r is None else {"synced": r[0], "viewed": r[1], "complete": bool(r[2])}


def mark(market: str, symbol: str, iv: str, *, synced: bool = False, viewed: bool = False,
         complete: bool | None = None) -> None:
    now = time.time()
    with _lock:
        con = _con()
        con.execute("INSERT OR IGNORE INTO series VALUES (?,?,?,0,0,0)", (market, symbol, iv))
        if synced:
            con.execute("UPDATE series SET synced=? WHERE market=? AND symbol=? AND iv=?", (now, market, symbol, iv))
        if viewed:
            con.execute("UPDATE series SET viewed=? WHERE market=? AND symbol=? AND iv=?", (now, market, symbol, iv))
        if complete is not None:
            con.execute("UPDATE series SET complete=? WHERE market=? AND symbol=? AND iv=?",
                        (int(complete), market, symbol, iv))
        con.commit()


def recent(since_sec: float) -> list[tuple[str, str, str, float]]:
    """最近 since_sec 秒內被看過的組合：(market, symbol, iv, synced)。"""
    cut = time.time() - since_sec
    return [tuple(r) for r in _con().execute(
        "SELECT market, symbol, iv, synced FROM series WHERE viewed>? ORDER BY viewed DESC", (cut,)).fetchall()]


def stats() -> dict:
    con = _con()
    n_bars = con.execute("SELECT COUNT(*) FROM bars").fetchone()[0]
    n_series = con.execute("SELECT COUNT(*) FROM series").fetchone()[0]
    size = sum(p.stat().st_size for p in (_path, Path(f"{_path}-wal")) if p and p.exists())   # 含 WAL（還沒寫回主檔的部分）
    return {"bars": n_bars, "series": n_series, "mb": round(size / 1e6, 1)}
