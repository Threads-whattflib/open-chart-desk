"""內建價格提醒：存在 data/alerts.db，背景執行緒每 ALERT_INTERVAL 秒（預設 15）查一次現價，
穿越目標價就發通知，觸發一次就停用（從清單消失，資料庫裡留 fired_at 紀錄）。

方向在建立時決定：目標價在現價上面＝向上穿越（現價 >= 目標價觸發），下面＝向下穿越（現價 <= 目標價觸發）。

通知管道（環境變數，可以同時開；都沒設也會觸發，只是只寫 log）：
  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   Telegram 私訊或群組
  ALERT_WEBHOOK_URL                       POST JSON {"text", "content", "market", "symbol", "price", "target", "direction", "note"}
                                          （text 給 Slack，content 給 Discord，其他欄位給自己的服務）
ALERT_INTERVAL 最小 5 秒。查價用 data_sources.quotes，跟觀察清單同一套快取。
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from fastapi import HTTPException

import data_sources as ds

INTERVAL = max(5, int(os.environ.get("ALERT_INTERVAL", "15")))
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
WEBHOOK = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
MAX_ACTIVE = 500

_db_path: Path | None = None
_lock = threading.Lock()


def _log(msg: str) -> None:
    print(f"[alerts] {msg}", flush=True)


def _conn() -> sqlite3.Connection:
    assert _db_path is not None, "alerts.init() 還沒呼叫"
    c = sqlite3.connect(_db_path, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def init(path: Path) -> None:
    """建表並啟動背景檢查執行緒。"""
    global _db_path
    _db_path = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL, symbol TEXT NOT NULL,
            direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
            target REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, fired_at TEXT, fired_price REAL)""")
        c.execute("CREATE INDEX IF NOT EXISTS ix_alerts_active ON alerts (fired_at, market, symbol)")
    threading.Thread(target=_loop, daemon=True, name="alert-monitor").start()
    chans = [n for n, on in (("telegram", TG_TOKEN and TG_CHAT), ("webhook", WEBHOOK)) if on]
    _log(f"每 {INTERVAL} 秒檢查；通知管道：{', '.join(chans) or '沒有（只寫 log）'}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "price": r["target"], "dir": r["direction"], "note": r["note"], "at": r["created_at"]}


def list_for(market: str, symbol: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM alerts WHERE fired_at IS NULL AND market=? AND symbol=? ORDER BY target DESC",
                         (market, symbol)).fetchall()
    return [_row(r) for r in rows]


def create(market: str, symbol: str, price: float, last: float, note: str) -> dict:
    """last 是前端圖上的最後價，只當備用：方向用背景檢查同一個來源（ds.quotes）查到的現價決定。
    美股盤前盤後時圖上的價格含延長盤、ds.quotes 是正規盤收盤，用圖上的價決定方向會一建立就誤觸發。"""
    q = ds.quotes([(market, symbol)]).get(f"{market}:{symbol}")
    if q and q.get("p"):
        last = q["p"]
    elif market == "crypto":
        raise HTTPException(400, "查不到這個商品的現價，無法建立提醒")
    direction = "above" if price >= last else "below"
    note = note.strip()[:200]
    with _lock, _conn() as c:
        n = c.execute("SELECT COUNT(*) FROM alerts WHERE fired_at IS NULL").fetchone()[0]
        if n >= MAX_ACTIVE:
            raise HTTPException(400, f"有效提醒最多 {MAX_ACTIVE} 個")
        cur = c.execute("INSERT INTO alerts (market, symbol, direction, target, note, created_at) VALUES (?,?,?,?,?,?)",
                        (market, symbol, direction, price, note, _now()))
        aid = cur.lastrowid
    return {"id": aid, "price": price, "dir": direction, "note": note}


def delete(aid: int) -> None:
    with _lock, _conn() as c:
        if not c.execute("DELETE FROM alerts WHERE id=? AND fired_at IS NULL", (aid,)).rowcount:
            raise HTTPException(404, "找不到這個提醒（可能已經觸發）")


def _fmt(v: float) -> str:
    return f"{v:,.2f}" if v >= 1 else f"{v:.6g}"


def _notify(a: sqlite3.Row, price: float) -> None:
    arrow = "↑ 向上穿越" if a["direction"] == "above" else "↓ 向下穿越"
    text = f"⏰ {a['symbol']} {arrow} {_fmt(a['target'])}\n現價 {_fmt(price)}" + (f"\n{a['note']}" if a["note"] else "")
    if TG_TOKEN and TG_CHAT:
        try:
            r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                              json={"chat_id": TG_CHAT, "text": text}, timeout=10)
            if not r.ok:
                _log(f"[WARN] telegram {r.status_code}")
        except requests.RequestException as e:
            _log(f"[WARN] telegram {type(e).__name__}")
    if WEBHOOK:
        try:
            r = requests.post(WEBHOOK, timeout=10, json={
                "text": text, "content": text, "market": a["market"], "symbol": a["symbol"], "price": price,
                "target": a["target"], "direction": a["direction"], "note": a["note"]})
            if not r.ok:
                _log(f"[WARN] webhook {r.status_code}")
        except requests.RequestException as e:
            _log(f"[WARN] webhook {type(e).__name__}")
    _log(text.replace("\n", " | "))


def check_once() -> int:
    """查一輪，回傳這輪觸發幾個。"""
    with _conn() as c:
        rows = c.execute("SELECT * FROM alerts WHERE fired_at IS NULL").fetchall()
    if not rows:
        return 0
    pairs = sorted({(r["market"], r["symbol"]) for r in rows})
    quotes = ds.quotes(pairs)
    fired = 0
    for r in rows:
        q = quotes.get(f"{r['market']}:{r['symbol']}")
        p = q.get("p") if q else None
        if not p:
            continue
        if (r["direction"] == "above" and p >= r["target"]) or (r["direction"] == "below" and p <= r["target"]):
            with _lock, _conn() as c:   # 先標記再通知：通知失敗也不會每輪重發
                if not c.execute("UPDATE alerts SET fired_at=?, fired_price=? WHERE id=? AND fired_at IS NULL",
                                 (_now(), p, r["id"])).rowcount:
                    continue
            _notify(r, p)
            fired += 1
    return fired


def _loop() -> None:
    while True:
        try:
            check_once()
        except Exception as e:
            _log(f"[ERR] 檢查失敗：{type(e).__name__}: {e}")
        time.sleep(INTERVAL)
