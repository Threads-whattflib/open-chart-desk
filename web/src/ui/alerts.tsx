// 價格提醒的畫面：十字線價格旁的 ⊕ 選單（手機底部頁）、新增提醒、提醒清單。
// 提醒存在後端（server/alerts.py，data/alerts.db），背景每 15 秒查價，觸發後照設定發 Telegram / webhook。
import { useState } from "react";
import type { Alert } from "../api";
import { Icon } from "./icons";
import { Sheet } from "./sheet";

/** 手機：點 ⊕ 後的底部頁（照 TradingView：第一列加提醒，最後一列畫水平線）。 */
export function PlusSheet({ label, symbol, onAlert, onHline, onClose }: {
  label: string; symbol: string; onAlert(): void; onHline(): void; onClose(): void;
}) {
  return (
    <Sheet title="" onClose={onClose}>
      <div className="more-list plus-list">
        <button className="more-row" onClick={() => { onClose(); onAlert(); }}>
          <Icon name="alarmPlus" size={24} /><span>在 {label} 增加關於 {symbol} 的提醒</span>
        </button>
        <button className="more-row" onClick={() => { onClose(); onHline(); }}>
          <Icon name="hline" size={24} /><span>在 {label} 繪製水平線</span>
        </button>
      </div>
    </Sheet>
  );
}

export function AlertCreate({ symbol, price, last, fmt, onSave, onClose }: {
  symbol: string; price: number; last: number; fmt(v: number): string;
  onSave(price: number, note: string): Promise<void>; onClose(): void;
}) {
  const [text, setText] = useState(fmt(price).replace(/,/g, ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const p = Number(text);
  const ok = Number.isFinite(p) && p > 0;
  const up = ok && p >= last;
  const save = () => {
    if (!ok || busy) return;
    setBusy(true); setErr("");
    onSave(p, note).then(onClose, (e: Error) => { setErr(e.message || "新增失敗"); setBusy(false); });
  };
  return (
    <Sheet title={`新增價格提醒 · ${symbol}`} onClose={onClose} foot={
      <div className="cfg-foot">
        <button className="cfg-btn" onClick={onClose}>取消</button>
        <button className="cfg-btn solid" disabled={!ok || busy} onClick={save}>{busy ? "建立中…" : "建立"}</button>
      </div>
    }>
      <section className="cfg-sec">
        <label className="cfg-row"><span>價格</span>
          <input className="num-in alert-in" inputMode="decimal" autoFocus value={text}
            onChange={(e) => setText(e.target.value.trim())} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </label>
        <p className="alert-cond">
          {ok ? <>條件：價格<b className={up ? "up" : "down"}>{up ? "向上穿越" : "向下穿越"}</b> {fmt(p)}（現價 {fmt(last)}）</> : "請輸入價格"}
        </p>
        <label className="cfg-row"><span>備註</span>
          <input className="num-in alert-in" value={note} maxLength={200} placeholder="可留空" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </label>
        <p className="alert-hint">觸發一次就停用。通知管道由架站的人在伺服器設定（Telegram / webhook）。</p>
        {err && <p className="alert-err">{err}</p>}
      </section>
    </Sheet>
  );
}

export function AlertList({ symbol, items, fmt, err, onAdd, onDelete, onClose }: {
  symbol: string; items: Alert[]; fmt(v: number): string; err: string;
  onAdd(): void; onDelete(a: Alert): void; onClose(): void;
}) {
  return (
    <Sheet title={`價格提醒 · ${symbol}`} onClose={onClose} foot={
      <div className="cfg-foot"><button className="cfg-btn solid" onClick={onAdd}>新增提醒</button></div>
    }>
      <section className="cfg-sec">
        {err && <p className="alert-err">{err}</p>}
        {!items.length && !err && <p className="alert-hint">這檔還沒有提醒。也可以在圖上長按（電腦：滑鼠移到價格旁）點 ⊕ 新增。</p>}
        <ul className="alert-list">
          {items.map((a) => (
            <li key={a.id}>
              <Icon name="alarm" size={18} />
              <span className="al-main"><b>{a.dir === "above" ? "向上穿越" : "向下穿越"} {fmt(a.price)}</b>{a.note && <i>{a.note}</i>}</span>
              <button className="icon-btn" aria-label={`刪除 ${fmt(a.price)} 的提醒`} onClick={() => onDelete(a)}><Icon name="trash" size={18} /></button>
            </li>
          ))}
        </ul>
      </section>
    </Sheet>
  );
}
