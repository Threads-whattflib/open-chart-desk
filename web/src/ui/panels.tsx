import { useEffect, useRef, useState } from "react";
import { searchSymbols } from "../api";
import { MARKET_LABEL, symKey, type Settings, type Sym } from "../types";
import { Icon, SymIcon } from "./icons";

// ── 商品搜尋 ──
const TABS: [string, string][] = [["all", "全部"], ["crypto", "加密"], ["tw", "台股"], ["us", "美股"]];

export function SymbolSearch({ initial, title, onPick, onClose }: {
  initial: string; title: string; onPick(s: Sym): void; onClose(): void;
}) {
  const [q, setQ] = useState(initial);
  const [m, setM] = useState("all");
  const [list, setList] = useState<Sym[]>([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let dead = false;
    setBusy(true);
    const id = window.setTimeout(() => {
      searchSymbols(q, m).then((r) => { if (!dead) { setList(r); setIdx(0); } })
        .catch(() => { if (!dead) setList([]); }).finally(() => { if (!dead) setBusy(false); });
    }, q ? 160 : 0);
    return () => { dead = true; clearTimeout(id); };
  }, [q, m]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="search-in">
          <Icon name="search" size={22} />
          <input autoFocus value={q} placeholder={`${title}：代號或名稱，例如 BTC、2330、台積電、NVDA`} spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter" && list[idx]) onPick(list[idx]);
              else if (e.key === "Escape") onClose();
            }} />
          <button className="icon-btn" aria-label="關閉" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="seg" role="tablist" aria-label="市場">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={m === id} className={m === id ? "on" : ""} onClick={() => setM(id)}>{label}</button>
          ))}
        </div>
        <ul className="results" ref={listRef}>
          {list.map((s, i) => (
            <li key={symKey(s)} data-i={i} className={i === idx ? "on" : ""} onPointerEnter={() => setIdx(i)}
              onClick={() => onPick(s)}>
              <SymIcon sym={s} size={32} />
              <span className="r-main">
                <b>{s.symbol}</b>
                <span className="r-name">{s.name}<span className={`tag m-${s.market}`}>{MARKET_LABEL[s.market]}</span></span>
              </span>
              <span className="r-exch">{s.exch}</span>
            </li>
          ))}
          {!list.length && <li className="empty">{busy ? "搜尋中…" : "找不到符合的商品"}</li>}
        </ul>
      </div>
    </div>
  );
}

// ── 指標設定 ──
function Num({ value, onChange, min = 1, max = 500, step = 1 }: {
  value: number; onChange(v: number): void; min?: number; max?: number; step?: number;
}) {
  return (
    <input className="num-in" type="number" inputMode="decimal" value={value} min={min} max={max} step={step}
      onChange={(e) => { const v = Number(e.target.value); if (v >= min && v <= max) onChange(v); }} />
  );
}

export function IndicatorPanel({ s, set, onClose }: { s: Settings; set(p: Partial<Settings>): void; onClose(): void }) {
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="指標">
        <header className="modal-head">
          <b>指標</b>
          <button className="icon-btn" aria-label="關閉" onClick={onClose}><Icon name="close" /></button>
        </header>
        <IndicatorList s={s} set={set} />
      </div>
    </div>
  );
}

/** 指標開關與參數（電腦版彈窗、手機版底部頁共用）。 */
export function IndicatorList({ s, set }: { s: Settings; set(p: Partial<Settings>): void }) {
  const [maText, setMaText] = useState(s.ma.periods.join(", "));
  const row = (on: boolean, toggle: () => void, name: string, body?: JSX.Element) => (
    <div className="ind-row">
      <button className={`switch${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={name} onClick={toggle}><i /></button>
      <b>{name}</b>
      <span className="ind-args">{body}</span>
    </div>
  );
  return (
        <div className="ind-list">
          {row(s.vol, () => set({ vol: !s.vol }), "成交量")}
          {row(s.ma.on, () => set({ ma: { ...s.ma, on: !s.ma.on } }), "均線", <>
            <span className="seg tiny">
              {(["SMA", "EMA"] as const).map((t) => (
                <button key={t} className={s.ma.type === t ? "on" : ""} onClick={() => set({ ma: { ...s.ma, type: t } })}>{t}</button>
              ))}
            </span>
            <input className="num-in wide" value={maText} aria-label="均線週期，用逗號分開" placeholder="20, 60"
              onChange={(e) => {
                setMaText(e.target.value);
                const p = e.target.value.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 2 && n <= 500);
                if (p.length) set({ ma: { ...s.ma, periods: p.slice(0, 5) } });
              }} />
          </>)}
          {row(s.bb.on, () => set({ bb: { ...s.bb, on: !s.bb.on } }), "布林通道", <>
            <label>週期<Num value={s.bb.n} min={2} onChange={(n) => set({ bb: { ...s.bb, n } })} /></label>
            <label>倍數<Num value={s.bb.k} min={0.5} max={5} step={0.5} onChange={(k) => set({ bb: { ...s.bb, k } })} /></label>
          </>)}
          {row(s.rsi.on, () => set({ rsi: { ...s.rsi, on: !s.rsi.on } }), "RSI", <>
            <label>週期<Num value={s.rsi.n} min={2} onChange={(n) => set({ rsi: { ...s.rsi, n } })} /></label>
          </>)}
          {row(s.macd.on, () => set({ macd: { ...s.macd, on: !s.macd.on } }), "MACD", <>
            <label>快<Num value={s.macd.fast} min={2} onChange={(fast) => set({ macd: { ...s.macd, fast } })} /></label>
            <label>慢<Num value={s.macd.slow} min={3} onChange={(slow) => set({ macd: { ...s.macd, slow } })} /></label>
            <label>訊號<Num value={s.macd.signal} min={2} onChange={(signal) => set({ macd: { ...s.macd, signal } })} /></label>
          </>)}
        </div>
  );
}
