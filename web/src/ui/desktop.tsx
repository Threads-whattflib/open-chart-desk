// 電腦版介面：版面與手感仿 TradingView 網頁版。
// 左側工具列分組（點小箭頭展開、記住每組上次用的）、圖上可拖的收藏工具列與圖形工具列、右鍵選單、
// 右側觀察清單（市場分頁 + 自訂族群，規則同手機版）+ 商品詳情。圖示都是自己畫的。
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { absChg, fetchBars, fetchQuotes, type Quote } from "../api";
import { IV_SHORT, MARKET_LABEL, symKey, type Kind, type Market, type Sym, type Tool } from "../types";
import { useDragSort } from "./dragSort";
import { Icon, SymIcon } from "./icons";
import { groupUp, groupsOf, renameGroup, setGroup } from "./watchGroups";

// ── 左側工具列 ──
export const TOOL_GROUPS: { id: string; name: string; tools: [Kind, string, string?][] }[] = [
  { id: "line", name: "趨勢線工具", tools: [["trend", "趨勢線", "Alt+T"], ["ray", "射線"], ["ext", "延長線"], ["hline", "水平線", "Alt+H"],
    ["hray", "水平射線", "Alt+J"], ["vline", "垂直線", "Alt+V"], ["channel", "平行通道"]] },
  { id: "fib", name: "斐波那契", tools: [["fib", "斐波那契回撤", "Alt+F"], ["fibext", "斐波那契延伸"]] },
  { id: "shape", name: "圖形", tools: [["rect", "矩形", "Alt+Shift+R"]] },
  { id: "measure", name: "預測和測量", tools: [["long", "多頭倉位"], ["short", "空頭倉位"], ["prange", "價格範圍"], ["drange", "日期範圍"],
    ["measure", "價格與日期範圍"], ["frvp", "固定範圍成交量分佈圖"]] },
  { id: "note", name: "文字和標記", tools: [["text", "文字"], ["plabel", "價格標籤"], ["arrowup", "向上箭頭"], ["arrowdown", "向下箭頭"]] },
];
export const groupOf = (k: Kind) => TOOL_GROUPS.find((g) => g.tools.some(([t]) => t === k));
export const toolName = (k: Kind) => TOOL_GROUPS.flatMap((g) => g.tools).find(([t]) => t === k)?.[1] ?? k;

/** 點外面 / 按 Esc 就關（選單、展開的工具組、顏色盤共用）。 */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key); window.removeEventListener("blur", close); };
  }, [open, close, ref]);
}

export function ToolRail({ tool, onTool, last, fav, onFav, magnet, onMagnet, hidden, onHidden, count, onClear, deskFav, onDeskFav }: {
  tool: Tool; onTool(t: Tool): void; last: Record<string, Kind>; fav: Kind[]; onFav(k: Kind): void;
  magnet: boolean; onMagnet(): void; hidden: boolean; onHidden(): void; count: number; onClear(): void;
  deskFav: boolean; onDeskFav(): void;
}) {
  const [open, setOpen] = useState<{ id: string; top: number } | null>(null);
  const fly = useRef<HTMLDivElement>(null);
  useDismiss(!!open, () => setOpen(null), fly);
  const g = open && TOOL_GROUPS.find((x) => x.id === open.id);
  return (
    <nav className="rail" aria-label="畫圖工具">
      <button className={`rail-btn${tool === "cursor" ? " on" : ""}`} aria-pressed={tool === "cursor"} aria-label="游標"
        title="游標（Esc）" onClick={() => onTool("cursor")}><Icon name="cursor" size={22} /></button>
      {TOOL_GROUPS.map((grp) => {
        const active = grp.tools.some(([k]) => k === tool);
        const cur = active ? (tool as Kind) : last[grp.id] && grp.tools.some(([k]) => k === last[grp.id]) ? last[grp.id] : grp.tools[0][0];
        const many = grp.tools.length > 1;
        return (
          <div key={grp.id} className={`rail-grp${open?.id === grp.id ? " open" : ""}`}>
            <button className={`rail-btn${active ? " on" : ""}`} aria-pressed={active} aria-label={toolName(cur)}
              title={toolName(cur)} onClick={() => onTool(active ? "cursor" : cur)}><Icon name={cur} size={22} /></button>
            {many && (
              <button className="rail-more" aria-label={`展開${grp.name}`} aria-expanded={open?.id === grp.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  setOpen(open?.id === grp.id ? null : { id: grp.id, top: r.top });
                }}><Icon name="chevronRight" size={10} /></button>
            )}
          </div>
        );
      })}
      <span className="rail-sep" />
      <button className={`rail-btn${magnet ? " on" : ""}`} aria-pressed={magnet} aria-label="磁鐵"
        title="磁鐵：吸附到 K 棒的開高低收（按住 Ctrl 也可以）" onClick={onMagnet}><Icon name="magnet" size={22} /></button>
      <button className={`rail-btn${hidden ? " on" : ""}`} aria-pressed={hidden} aria-label="隱藏所有圖形"
        title={hidden ? "顯示所有圖形" : "隱藏所有圖形"} onClick={onHidden}><Icon name={hidden ? "eyeOff" : "eye"} size={22} /></button>
      <button className="rail-btn" disabled={!count} aria-label="刪除所有圖形" title={`刪除這個商品的所有圖形（${count}）`}
        onClick={onClear}><Icon name="trash" size={22} /></button>
      <span className="rail-fill" />
      <button className={`rail-btn${deskFav ? " on" : ""}`} aria-pressed={deskFav} aria-label="顯示收藏工具列"
        title="在圖表上顯示收藏的工具（在展開的工具組裡按星號加入）" onClick={onDeskFav}><Icon name="starLine" size={22} /></button>

      {g && open && (
        <div className="fly" ref={fly} role="menu" aria-label={g.name} style={{ top: Math.min(open.top, window.innerHeight - 44 - g.tools.length * 36) }}>
          <h4>{g.name}</h4>
          {g.tools.map(([k, name, key]) => (
            <div key={k} className={`fly-row${tool === k ? " on" : ""}`}>
              <button role="menuitem" onClick={() => { onTool(k); setOpen(null); }}>
                <Icon name={k} size={20} /><span>{name}</span>{key && <kbd>{key}</kbd>}
              </button>
              <button className={`fly-star${fav.includes(k) ? " on" : ""}`} aria-pressed={fav.includes(k)}
                aria-label={`收藏 ${name}`} onClick={() => onFav(k)}><Icon name={fav.includes(k) ? "star" : "starLine"} size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

// ── 可拖動的浮動工具列（收藏工具列、圖形工具列共用）──
// 抓左邊的點點拖；位置存成相對圖表區左上角的 px，畫面變小時夾回範圍內。
function useFloat(pos: { x: number; y: number } | undefined, onPos: (p: { x: number; y: number }) => void,
  fallback: (el: HTMLDivElement) => { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(pos);
  useEffect(() => setP(pos), [pos]);
  const clamp = (q: { x: number; y: number }) => {
    const el = ref.current, box = el?.parentElement;
    if (!el || !box) return q;
    return { x: Math.max(0, Math.min(box.clientWidth - el.offsetWidth, q.x)), y: Math.max(0, Math.min(box.clientHeight - el.offsetHeight, q.y)) };
  };
  const [, force] = useState(0);
  useLayoutEffect(() => { force((n) => n + 1); }, []);   // 第一次畫完才量得到寬度，用來置中
  const at = p ?? (ref.current ? fallback(ref.current) : { x: -9999, y: 0 });
  const grip = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as HTMLElement, x0 = e.clientX, y0 = e.clientY, start = clamp(at);
    el.setPointerCapture(e.pointerId);
    let q = start;
    const mv = (ev: PointerEvent) => { q = clamp({ x: start.x + ev.clientX - x0, y: start.y + ev.clientY - y0 }); setP(q); };
    const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); onPos(q); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
  };
  return { ref, style: { left: clamp(at).x, top: clamp(at).y }, grip };
}

export function FloatFav({ tools, tool, onTool, pos, onPos }: {
  tools: Kind[]; tool: Tool; onTool(t: Tool): void; pos?: { x: number; y: number }; onPos(p: { x: number; y: number }): void;
}) {
  const f = useFloat(pos, onPos, () => ({ x: 230, y: 50 }));
  return (
    <div className="float-bar" ref={f.ref} style={f.style} role="toolbar" aria-label="收藏的畫圖工具">
      <span className="grip" onPointerDown={f.grip} title="拖動" aria-hidden="true"><Icon name="grip" size={14} /></span>
      {tools.map((k) => (
        <button key={k} className={`fb-btn${tool === k ? " on" : ""}`} aria-pressed={tool === k} aria-label={toolName(k)} title={toolName(k)}
          onClick={() => onTool(tool === k ? "cursor" : k)}><Icon name={k} size={22} /></button>
      ))}
      {!tools.length && <span className="fb-empty">左側工具組展開後按星號加入</span>}
    </div>
  );
}

// ── 選中圖形時的浮動工具列 ──
const SWATCHES = ["#2f6bff", "#2962ff", "#16c784", "#089981", "#ff4d4d", "#f23645", "#f5b83d", "#ff9800",
  "#c77dff", "#9c27b0", "#2bb3a3", "#00bcd4", "#ecedf0", "#b2b5be", "#8a909c", "#434651"];

export function DrawBar({ color, width, dash, locked, text, pos, onPos, onPatch, onSettings, onText, onCopy, onDelete }: {
  color: string; width: number; dash: number; locked: boolean; text: boolean; pos?: { x: number; y: number };
  onPos(p: { x: number; y: number }): void; onPatch(p: { color?: string; width?: number; dash?: number; locked?: boolean }): void;
  onSettings(): void; onText(): void; onCopy(): void; onDelete(): void;
}) {
  const f = useFloat(pos, onPos, (el) => ({ x: Math.round(((el.parentElement?.clientWidth ?? 800) - 70 - el.offsetWidth) / 2), y: 46 }));
  const [pop, setPop] = useState<"" | "color" | "width" | "dash">("");
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss(!!pop, () => setPop(""), popRef);
  const DASH = ["實線", "虛線", "點線"];
  return (
    <div className="float-bar draw-bar" ref={f.ref} style={f.style} role="toolbar" aria-label="圖形設定">
      <span className="grip" onPointerDown={f.grip} title="拖動" aria-hidden="true"><Icon name="grip" size={14} /></span>
      <div className="fb-pop-wrap" ref={popRef}>
        <button className="fb-btn" aria-label="顏色" title="顏色" onClick={() => setPop(pop === "color" ? "" : "color")}>
          <Icon name="pen" size={20} /><i className="fb-color" style={{ background: color }} />
        </button>
        <button className="fb-btn txt" aria-label="線寬" title="線寬" onClick={() => setPop(pop === "width" ? "" : "width")}>
          <span className="wline" style={{ height: width }} /><small>{width}px</small>
        </button>
        <button className="fb-btn" aria-label="線型" title="線型" onClick={() => setPop(pop === "dash" ? "" : "dash")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={dash === 1 ? "5 4" : dash === 2 ? "1.5 3.5" : undefined}
            strokeLinecap="round"><path d="M3 12h18" /></svg>
        </button>
        {pop === "color" && (
          <div className="fb-pop colors">
            {SWATCHES.map((c) => (
              <button key={c} className={`swatch${color === c ? " on" : ""}`} style={{ background: c }} aria-label={`顏色 ${c}`}
                onClick={() => { onPatch({ color: c }); setPop(""); }} />
            ))}
          </div>
        )}
        {pop === "width" && (
          <div className="fb-pop list">
            {[1, 2, 3, 4].map((w) => (
              <button key={w} className={width === w ? "on" : ""} onClick={() => { onPatch({ width: w }); setPop(""); }}>
                <span className="wline" style={{ height: w, width: 40 }} />{w}px
              </button>
            ))}
          </div>
        )}
        {pop === "dash" && (
          <div className="fb-pop list">
            {DASH.map((n, i) => (
              <button key={n} className={dash === i ? "on" : ""} onClick={() => { onPatch({ dash: i }); setPop(""); }}>
                <svg width="40" height="10" viewBox="0 0 40 10" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeDasharray={i === 1 ? "6 4" : i === 2 ? "1.5 3.5" : undefined} strokeLinecap="round"><path d="M1 5h38" /></svg>{n}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="fb-sep" />
      {text && <button className="fb-btn txt" onClick={onText}>改字</button>}
      <button className="fb-btn" aria-label="設定" title="設定（在圖形上連點兩下也可以）" onClick={onSettings}><Icon name="gear" size={20} /></button>
      <button className={`fb-btn${locked ? " on" : ""}`} aria-pressed={locked} aria-label={locked ? "解除鎖定" : "鎖定"} title={locked ? "解除鎖定" : "鎖定"}
        onClick={() => onPatch({ locked: !locked })}><Icon name="lock" size={20} /></button>
      <button className="fb-btn" aria-label="複製" title="複製一份" onClick={onCopy}><Icon name="copy" size={20} /></button>
      <button className="fb-btn danger" aria-label="刪除" title="刪除（Delete）" onClick={onDelete}><Icon name="trash" size={20} /></button>
    </div>
  );
}

// ── 右鍵選單 ──
export type MenuItem = "sep" | { label: string; hint?: string; icon?: string; check?: boolean; disabled?: boolean; danger?: boolean; act(): void };

export function CtxMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useDismiss(true, onClose, ref);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setAt({ x: Math.min(x, window.innerWidth - el.offsetWidth - 6), y: Math.min(y, window.innerHeight - el.offsetHeight - 6) });
  }, [x, y]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, []);
  return (
    <div className="ctx" ref={ref} role="menu" style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const bs = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus();
      }}>
      {items.map((it, i) => it === "sep" ? <hr key={i} /> : (
        <button key={i} role={it.check != null ? "menuitemcheckbox" : "menuitem"} aria-checked={it.check} disabled={it.disabled}
          className={it.danger ? "danger" : ""} onClick={() => { onClose(); it.act(); }}>
          <span className="ctx-ic">{it.check ? <Icon name="check" size={16} /> : it.icon ? <Icon name={it.icon} size={16} /> : null}</span>
          <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

// ── 右側：觀察清單 + 商品詳情 ──
const fmtP = (p: number) => p.toLocaleString("en-US", {
  minimumFractionDigits: p >= 100 ? 2 : p >= 1 ? 3 : 4, maximumFractionDigits: p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 6,
});
const sign = (v: number) => (v >= 0 ? "+" : "−");
const TABS: [string, string][] = [["all", "全部"], ["crypto", "加密"], ["tw", "台股"], ["us", "美股"]];
const MARKETS: Market[] = ["crypto", "tw", "us"];

export function WatchPanel({ items: all, current, tab, onTab, onPick, onEdit, onMove, onAdd, onClose, detail, onDetail }: {
  items: Sym[]; current: Sym; tab: string; onTab(t: string): void; onPick(s: Sym): void;
  onEdit(f: (list: Sym[]) => Sym[]): void; onMove(from: number, to: number): void; onAdd(): void; onClose(): void;
  detail: boolean; onDetail(): void;
}) {
  const items = tab === "all" ? all : all.filter((x) => x.market === tab);
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const keys = all.map(symKey).join(",");
  useEffect(() => {
    if (!keys) return;
    let dead = false;
    const load = () => { if (!document.hidden) fetchQuotes(keys.split(",")).then((q) => { if (!dead) setQuotes(q); }).catch(() => {}); };
    load();
    const id = window.setInterval(load, 8000);
    return () => { dead = true; clearInterval(id); };
  }, [keys]);

  const askGroup = (cur = "") => window.prompt("族群名稱（留空 = 解散，商品變未分類）", cur);
  const rowMenu = (e: React.MouseEvent, s: Sym) => {
    e.preventDefault();
    const groups = groupsOf(all, s.market).map((g) => g.name).filter(Boolean);
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: `切換到 ${s.symbol}`, icon: "indicator", act: () => onPick(s) },
      "sep",
      ...groups.map((g) => ({ label: `移到「${g}」`, check: s.group === g, act: () => onEdit((w) => setGroup(w, s, g)) })),
      ...(s.group ? [{ label: "移到「未分類」", act: () => onEdit((w) => setGroup(w, s, "")) }] : []),
      { label: "新增族群並移入…", icon: "plus", act: () => { const n = window.prompt("新族群名稱")?.trim(); if (n) onEdit((w) => setGroup(w, s, n)); } },
      "sep",
      { label: `從觀察清單移除 ${s.symbol}`, icon: "trash", danger: true, act: () => onEdit((w) => w.filter((x) => symKey(x) !== symKey(s))) },
    ] });
  };
  const grpMenu = (e: React.MouseEvent, mk: Market, name: string, first: boolean) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "改名…", icon: "edit", act: () => { const n = askGroup(name); if (n !== null) onEdit((w) => renameGroup(w, mk, name, n.trim())); } },
      { label: "往上移", icon: "chevron", disabled: first, act: () => onEdit((w) => groupUp(w, mk, name)) },
      { label: "解散（商品變未分類）", icon: "close", danger: true, act: () => onEdit((w) => renameGroup(w, mk, name, "")) },
    ] });
  };
  const markets = tab === "all" ? MARKETS : MARKETS.filter((m) => m === tab);
  return (
    <aside className="wp" aria-label="觀察清單">
      <div className="wp-list-part">
        <header className="wp-head">
          <b>觀察清單</b>
          <span>
            <button className="ic" aria-label="加入商品" title="加入商品" onClick={onAdd}><Icon name="plus" size={20} /></button>
            <button className={`ic${detail ? " on" : ""}`} aria-pressed={detail} aria-label="商品詳情" title="顯示 / 隱藏商品詳情"
              onClick={onDetail}><Icon name="info" size={19} /></button>
            <button className="ic wp-x" aria-label="關閉觀察清單" onClick={onClose}><Icon name="close" size={18} /></button>
          </span>
        </header>
        <div className="wp-tabs" role="tablist" aria-label="市場">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
              {label}{id !== "all" && <small>{all.filter((x) => x.market === id).length}</small>}
            </button>
          ))}
        </div>
        <div className="wp-cols" role="row"><span>商品</span><span>最新價</span><span>漲跌</span><span>漲跌%</span></div>
        <div className="wp-scroll">
          {markets.map((mk) => {
            const gs = groupsOf(all, mk);
            if (!gs.length) return null;
            const named = gs.some((g) => g.name);
            return (
              <Fragment key={mk}>
                {tab === "all" && <h4 className="wp-sec">{MARKET_LABEL[mk]}<small>{gs.reduce((n, g) => n + g.syms.length, 0)}</small></h4>}
                {gs.map((g, gi) => (
                  <WatchRows key={g.name || "_"} all={all} syms={g.syms} current={current} quotes={quotes} onPick={onPick} onMove={onMove}
                    onMenu={rowMenu} onRemove={(s) => onEdit((w) => w.filter((x) => symKey(x) !== symKey(s)))}
                    header={named && (
                      <h5 className="wp-grp" onContextMenu={(e) => g.name && grpMenu(e, mk, g.name, gi === 0)}
                        title={g.name ? "右鍵：改名、往上移、解散" : undefined}>
                        {g.name || "未分類"}<small>{g.syms.length}</small>
                      </h5>
                    )} />
                ))}
              </Fragment>
            );
          })}
          {!items.length && <p className="empty">{all.length ? "這一頁沒有商品，按右上角 + 加入" : "觀察清單是空的，按右上角 + 加入"}</p>}
          {items.length > 0 && <p className="wp-tip">按住拖動排序（同一族群內）；右鍵：換族群、移除</p>}
        </div>
      </div>
      {detail && <Detail sym={current} quote={quotes[symKey(current)]} />}
      {menu && <CtxMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function WatchRows({ all, syms, header, current, quotes, onPick, onMove, onMenu, onRemove }: {
  all: Sym[]; syms: Sym[]; header: ReactNode; current: Sym; quotes: Record<string, Quote | null>;
  onPick(s: Sym): void; onMove(from: number, to: number): void; onMenu(e: React.MouseEvent, s: Sym): void; onRemove(s: Sym): void;
}) {
  const ds = useDragSort((from, to) => onMove(all.indexOf(syms[from]), all.indexOf(syms[to])));
  return (
    <>
      {header}
      <ul className={`wp-list${ds.dragging >= 0 ? " sorting" : ""}`} ref={ds.ref}>
        {syms.map((s, i) => {
          const q = quotes[symKey(s)], on = symKey(s) === symKey(current);
          const abs = q ? absChg(q) : 0, tone = q ? (q.chg >= 0 ? "up" : "down") : "";
          return (
            <li key={symKey(s)} className={`${on ? "on" : ""}${ds.dragging === i ? " lift" : ""}`} style={ds.style(i)}
              onPointerDown={(e) => ds.start(i, e)} onContextMenu={(e) => onMenu(e, s)}>
              <button className="wp-row" aria-current={on} onClick={() => { if (!ds.blocked()) onPick(s); }}>
                <span className="wp-sym"><SymIcon sym={s} size={18} /><b>{s.symbol}</b>{s.market === "tw" && <i>{s.name}</i>}</span>
                <span className="wp-num">{q ? fmtP(q.p) : "—"}</span>
                <span className={`wp-num ${tone}`}>{q ? `${sign(abs)}${fmtP(Math.abs(abs))}` : ""}</span>
                <span className={`wp-num ${tone}`}>{q ? `${sign(q.chg)}${Math.abs(q.chg).toFixed(2)}%` : ""}</span>
              </button>
              <button className="wp-del" aria-label={`移除 ${s.symbol}`} title="從觀察清單移除" onClick={() => onRemove(s)}>
                <Icon name="close" size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 交易時段（不含國定假日）：加密 24 小時；台股 09:00–13:30（台北）；美股 09:30–16:00（紐約）。 */
function marketOpen(m: Market): boolean {
  if (m === "crypto") return true;
  const tz = m === "tw" ? "Asia/Taipei" : "America/New_York";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return m === "tw" ? mins >= 540 && mins < 810 : mins >= 570 && mins < 960;
}
const fmtVol = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(0));
const unitOf = (s: Sym) => (s.market === "tw" ? "TWD" : s.market === "us" ? "USD" : (s.symbol.match(/(USDT|USDC|BTC|ETH)$/)?.[1] ?? ""));

function Detail({ sym, quote }: { sym: Sym; quote: Quote | null | undefined }) {
  const [q, setQ] = useState<Quote | null>(null);
  const [day, setDay] = useState<{ v: number; avg: number; lo: number; hi: number } | null>(null);
  const key = symKey(sym);
  useEffect(() => {
    let dead = false;
    setDay(null); setQ(null);
    const load = () => {
      if (document.hidden) return;
      if (!quote) fetchQuotes([key]).then((r) => { if (!dead) setQ(r[key] ?? null); }).catch(() => {});
      fetchBars(sym.market, sym.symbol, "1d", undefined, 31).then(({ bars }) => {
        if (dead || !bars.length) return;
        const last = bars[bars.length - 1], prev = bars.slice(-31, -1);
        setDay({ v: last.v, avg: prev.length ? prev.reduce((n, b) => n + b.v, 0) / prev.length : 0, lo: last.l, hi: last.h });
      }).catch(() => {});
    };
    load();
    const id = window.setInterval(load, 30000);
    return () => { dead = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const qt = quote ?? q;
  const abs = qt ? absChg(qt) : 0, tone = qt ? (qt.chg >= 0 ? "up" : "down") : "";
  const open = marketOpen(sym.market);
  const pos = day && qt && day.hi > day.lo ? Math.max(0, Math.min(1, (qt.p - day.lo) / (day.hi - day.lo))) : null;
  return (
    <section className="wp-detail" aria-label={`${sym.symbol} 商品詳情`}>
      <div className="dt-head"><SymIcon sym={sym} size={26} /><b>{sym.symbol}</b></div>
      <p className="dt-name">{sym.market === "tw" ? `${sym.symbol} ${sym.name}` : sym.name || sym.symbol}<span> · {sym.exch}</span></p>
      <p className="dt-type">{MARKET_LABEL[sym.market]}{sym.group ? ` · ${sym.group}` : ""}</p>
      <div className="dt-price">
        <b className={tone}>{qt ? fmtP(qt.p) : "—"}</b><small>{unitOf(sym)}</small>
        {qt && <span className={tone}>{sign(abs)}{fmtP(Math.abs(abs))}  {sign(qt.chg)}{Math.abs(qt.chg).toFixed(2)}%</span>}
      </div>
      <p className={`dt-open${open ? " on" : ""}`} title={sym.market === "crypto" ? "24 小時交易" : "依交易時段判斷，未計國定假日"}>
        <i />{open ? "開市" : "收市"}
      </p>
      {day && (
        <div className="dt-grid">
          <div><span>成交量</span><b>{fmtVol(day.v)}</b></div>
          <div className="r"><span>平均成交量（30 天）</span><b>{fmtVol(day.avg)}</b></div>
          <div className="dt-bar"><i style={{ width: `${day.avg ? Math.min(100, (day.v / day.avg) * 50) : 0}%` }} /></div>
          <div><span>當日低</span><b>{fmtP(day.lo)}</b></div>
          <div className="r"><span>當日高</span><b>{fmtP(day.hi)}</b></div>
          <div className="dt-range">{pos != null && <i style={{ left: `${pos * 100}%` }} />}</div>
        </div>
      )}
    </section>
  );
}

// ── 直接打數字換週期（跟 TradingView 一樣：打 15 按 Enter = 15 分；4h、1d、W、M 也可以）──
export function parseIv(text: string, ivs: string[]): string | null {
  const t = text.trim().toLowerCase();
  const m = t.match(/^(\d*)([smhdwm]?)$/i);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1, u = text.trim().slice(-1) === "M" ? "M" : m[2];
  let key = "";
  if (!u) key = n % 60 === 0 && n >= 60 ? `${n / 60}h` : `${n}m`;
  else if (u === "h") key = `${n}h`;
  else if (u === "d") key = `${n}d`;
  else if (u === "w") key = `${n}w`;
  else if (u === "M") key = `${n}M`;
  else if (u === "m") key = `${n}m`;
  return ivs.includes(key) ? key : null;
}

export function IvInput({ text, ok }: { text: string; ok: boolean }) {
  return (
    <div className="iv-input" role="status">
      <b>{text}</b>
      <span>{ok ? "按 Enter 切換週期" : "沒有這個週期"}</span>
    </div>
  );
}

export const DESK_IV: Record<string, string> = {
  "1m": "1分", "3m": "3分", "5m": "5分", "15m": "15分", "30m": "30分", "1h": "1h", "2h": "2h", "4h": "4h", "1d": "D", "1w": "W", "1M": "月",
};
export const ivTitle = (iv: string) => IV_SHORT[iv];

/** 圖表底部右邊的時鐘：HH:MM:SS UTC+8（瀏覽器當地時區）。 */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const off = -now.getTimezoneOffset() / 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return <span className="clock">{p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())} UTC{off >= 0 ? "+" : ""}{off}</span>;
}
