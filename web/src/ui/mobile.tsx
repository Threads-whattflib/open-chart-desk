// 手機版介面：版面照 TradingView 手機 app（全螢幕圖表、下方兩顆浮動膠囊、底部彈出頁）。
// 工具圖示是自己畫的；商品 logo 的來源見 server/logos.py（LOGO_SOURCE）。
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { absChg, fetchQuotes, searchSymbols, type Quote } from "../api";

const EXT_NAME = { pre: "盤前（Yahoo）", post: "盤後（Yahoo）", token: "隔夜：Binance bStock 代幣價，不是交易所成交" };
import { SPANS } from "../chart/ChartPane";
import { IV_SHORT, MARKET_LABEL, symKey, type Kind, type Market, type Settings, type Sym, type Tool } from "../types";
import { useDragSort } from "./dragSort";
import { groupUp, groupsOf, renameGroup, setGroup } from "./watchGroups";
import { Icon, SymIcon } from "./icons";
import { IndicatorList } from "./panels";
import { Sheet } from "./sheet";

// ── 滾輪：上下滾動一排項目，停下來（手指也放開）才切換；點一下則開完整清單 ──
// 頭尾相接：把整排項目重複很多份，一開始停在正中間那一份，怎麼滾都還有東西；停下來後悄悄跳回中間那一份的同一格。
export function Wheel<T>({ items, index, onPick, onTap, render, label, className = "" }: {
  items: T[]; index: number; onPick(i: number): void; onTap(): void; render(item: T): ReactNode; label: string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ timer: 0, self: false, touching: false, rolling: false });
  const n = items.length;
  const copies = n > 1 ? Math.max(9, Math.ceil(80 / n) | 1) : 1;      // 只有一個項目就不用循環
  const base = Math.floor(copies / 2) * n;
  const home = (el: HTMLDivElement) => {
    const top = (base + Math.max(0, index)) * el.clientHeight;
    if (Math.abs(el.scrollTop - top) > 1) { st.current.self = true; el.scrollTop = top; }
  };
  // 外部換了商品 / 週期、或清單長度變了：對回中間那一份。使用者正在滾的時候不動它（不然會被拉回去）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const s = st.current; if (ref.current && !s.touching && !s.rolling) home(ref.current); }, [index, n]);
  // 卸載時清掉還沒觸發的計時器（例：滾完 170ms 內按「收起工具列」，滾輪被拿掉）
  useEffect(() => () => clearTimeout(st.current.timer), []);
  const settle = () => {
    const el = ref.current, s = st.current;
    clearTimeout(s.timer);
    if (!s.self) s.rolling = true;
    s.timer = window.setTimeout(() => {
      // 元素已不在畫面上（或高度 0）時 scrollTop / clientHeight 會是 NaN，onPick(NaN) 會把 undefined 當商品傳出去、整頁掛掉
      if (!el || !n || !el.isConnected || !el.clientHeight) return;
      if (s.touching) { settle(); return; }          // 手指還按著：等放開
      s.rolling = false;
      if (s.self) { s.self = false; return; }
      const i = ((Math.round(el.scrollTop / el.clientHeight) % n) + n) % n;
      if (!Number.isInteger(i)) return;
      if (i !== index) onPick(i); else home(el);
    }, 170);
  };
  return (
    <div ref={ref} className={`wheel ${className}`} role="button" tabIndex={0} aria-label={label} onScroll={settle} onClick={onTap}
      onTouchStart={() => { st.current.touching = true; }} onTouchEnd={() => { st.current.touching = false; settle(); }}
      onTouchCancel={() => { st.current.touching = false; settle(); }}>
      {Array.from({ length: copies * n }, (_, k) => <div className="wheel-item" key={k}>{render(items[k % n])}</div>)}
    </div>
  );
}

// ── 觀察清單 + 搜尋 ──
const fmtP = (p: number) => p.toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: p >= 1 ? 2 : p >= 0.01 ? 4 : 6,
});
const SEARCH_TABS: [string, string][] = [["all", "全部"], ["crypto", "加密"], ["tw", "台股"], ["us", "美股"]];

export const MARKET_ORDER: Market[] = ["crypto", "tw", "us"];   // 「全部」頁分段的順序（跟分頁一樣）

export function WatchSheet({ items: all, current, onPick, onToggle, onMove, onEdit, tab, onTab, onClose }: {
  items: Sym[]; current: Sym; onPick(s: Sym): void; onToggle(s: Sym): void; onMove(from: number, to: number): void;
  onEdit(f: (list: Sym[]) => Sym[]): void; tab: string; onTab(t: string): void; onClose(): void;
}) {
  // 市場分頁：同一份清單按商品自己的市場篩選；「全部」頁按市場分段（加密 / 台股 / 美股）
  const items = tab === "all" ? all : all.filter((x) => x.market === tab);
  const [q, setQ] = useState("");
  const [m, setM] = useState("all");
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState<Sym | null>(null);   // 編輯模式點一檔 → 選要放哪個族群
  const [found, setFound] = useState<Sym[]>([]);
  const [busy, setBusy] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const keys = items.map(symKey).join(",");

  useEffect(() => {
    if (!keys) return;
    let dead = false;
    const load = () => fetchQuotes(keys.split(",")).then((r) => { if (!dead) setQuotes(r); }).catch(() => {});
    load();
    const id = window.setInterval(load, 8000);
    return () => { dead = true; clearInterval(id); };
  }, [keys]);

  useEffect(() => {
    if (!q) { setFound([]); return; }
    let dead = false;
    setBusy(true);
    const id = window.setTimeout(() => {
      searchSymbols(q, m).then((r) => { if (!dead) setFound(r); }).catch(() => { if (!dead) setFound([]); })
        .finally(() => { if (!dead) setBusy(false); });
    }, 180);
    return () => { dead = true; clearTimeout(id); };
  }, [q, m]);

  // 編輯模式點商品 = 換族群；平常點 = 切換商品
  const row = { all, current, quotes, edit, onPick: edit ? setPick : onPick, onToggle, onMove };
  const markets = tab === "all" ? MARKET_ORDER : MARKET_ORDER.filter((mk) => mk === tab);
  const askName = (cur = "") => window.prompt("族群名稱（留空 = 解散，商品變未分類）", cur);
  return (
    <>
    <Sheet title="" onClose={onClose} head={
      <div className="ws-top">
        <label className="ws-search">
          <Icon name="search" size={20} />
          <input value={q} placeholder="搜尋" spellCheck={false} autoCapitalize="characters" autoCorrect="off"
            onChange={(e) => setQ(e.target.value)} />
          {q && <button aria-label="清除" onClick={() => setQ("")}><Icon name="close" size={16} /></button>}
        </label>
        <div className="chips">
          {q ? SEARCH_TABS.map(([id, label]) => (
            <button key={id} className={m === id ? "on" : ""} onClick={() => setM(id)}>{label}</button>
          )) : (
            <>
              {SEARCH_TABS.map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
                  {label}{id !== "all" && <small>{all.filter((x) => x.market === id).length}</small>}
                </button>
              ))}
              <button className={`ws-edit${edit ? " on" : ""}`} onClick={() => setEdit(!edit)}>{edit ? "完成" : "編輯"}</button>
            </>
          )}
        </div>
      </div>
    }>
      {q ? (
        <>
          <WatchGroup {...row} syms={found} search />
          {!found.length && <p className="m-empty">{busy ? "搜尋中…" : "找不到符合的商品"}</p>}
        </>
      ) : (
        <>
          {edit && <p className="ws-hint">點商品換族群；點族群名稱改名；↑ 把族群往上移；按住 ≡ 拖動排序</p>}
          {markets.map((mk) => {
            const gs = groupsOf(all, mk);
            if (!gs.length) return null;
            const named = gs.some((g) => g.name);
            return (
              <Fragment key={mk}>
                {tab === "all" && <h4 className="ws-sec">{MARKET_LABEL[mk]}<small>{gs.reduce((n, g) => n + g.syms.length, 0)}</small></h4>}
                {gs.map((g, gi) => (
                  <WatchGroup key={g.name || "_"} {...row} syms={g.syms} header={named && (
                    <h5 className="ws-grp">
                      {edit && g.name ? (
                        <button onClick={() => { const n = askName(g.name); if (n !== null) onEdit((w) => renameGroup(w, mk, g.name, n.trim())); }}>
                          {g.name}<Icon name="edit" size={13} />
                        </button>
                      ) : <span>{g.name || "未分類"}</span>}
                      <small>{g.syms.length}</small>
                      {edit && g.name && gi > 0 && (
                        <button className="ws-up" aria-label={`${g.name} 往上移`} onClick={() => onEdit((w) => groupUp(w, mk, g.name))}>
                          <Icon name="chevron" size={16} />
                        </button>
                      )}
                    </h5>
                  )} />
                ))}
              </Fragment>
            );
          })}
        </>
      )}
      {!q && !items.length && (
        <p className="m-empty">{all.length ? "這一頁沒有商品，在上面搜尋後按 + 加入" : "觀察清單是空的，在上面搜尋後按 + 加入"}</p>
      )}
    </Sheet>
    {pick && (
      <Sheet title={`${pick.symbol} 放到哪個族群`} onClose={() => setPick(null)}>
        <ul className="grp-pick">
          {[...groupsOf(all, pick.market).map((g) => g.name).filter(Boolean), ""].map((g) => (
            <li key={g || "_"}>
              <button className={(pick.group || "") === g ? "on" : ""}
                onClick={() => { onEdit((w) => setGroup(w, pick, g)); setPick(null); }}>{g || "未分類"}</button>
            </li>
          ))}
          <li>
            <button className="new" onClick={() => {
              const n = window.prompt("新族群名稱")?.trim();
              if (n) onEdit((w) => setGroup(w, pick, n));
              setPick(null);
            }}><Icon name="plus" size={16} />新增族群</button>
          </li>
        </ul>
      </Sheet>
    )}
    </>
  );
}

/** 觀察清單的一段（一個市場，或一整頁）。排序：長按一列拿起來拖；編輯模式右邊的把手按住就能拖；只能在同一段裡拖。 */
function WatchGroup({ syms, all, header, search, current, quotes, edit, onPick, onToggle, onMove }: {
  syms: Sym[]; all: Sym[]; header?: ReactNode; search?: boolean; current: Sym; quotes: Record<string, Quote | null>;
  edit: boolean; onPick(s: Sym): void; onToggle(s: Sym): void; onMove(from: number, to: number): void;
}) {
  // 段內的位置換回整份清單的位置
  const ds = useDragSort((from, to) => onMove(all.indexOf(syms[from]), all.indexOf(syms[to])));
  const inList = (s: Sym) => all.some((x) => symKey(x) === symKey(s));
  const q = search;
  return (
    <>
      {header}
      <ul className={`ws-list${ds.dragging >= 0 ? " sorting" : ""}`} ref={q ? undefined : ds.ref}>
        {syms.map((s, i) => {
          const qt = q ? null : quotes[symKey(s)];
          const abs = qt ? absChg(qt) : 0;
          const on = symKey(s) === symKey(current);
          return (
            <li key={symKey(s)} className={`${on ? "on" : ""}${ds.dragging === i && !q ? " lift" : ""}`}
              style={q ? undefined : ds.style(i)} onPointerDown={q ? undefined : (e) => ds.start(i, e)}
              onContextMenu={(e) => e.preventDefault()}>
              <button className="ws-row" onClick={() => { if (!ds.blocked()) onPick(s); }}>
                <SymIcon sym={s} size={36} />
                <span className="ws-name">
                  <b>{s.symbol}{q && <em>{MARKET_LABEL[s.market]}</em>}</b>
                  <i>{s.name}</i>
                </span>
                {!q && (
                  <span className="ws-px">
                    <b>{qt ? fmtP(qt.p) : "—"}</b>
                    <i className={qt ? (qt.chg >= 0 ? "up" : "down") : ""}>
                      {qt ? `${abs >= 0 ? "+" : "−"}${fmtP(Math.abs(abs))} ${qt.chg >= 0 ? "+" : "−"}${Math.abs(qt.chg).toFixed(2)}%` : ""}
                    </i>
                  </span>
                )}
                {!q && qt?.ext && (
                  // 盤前盤後 / 隔夜那一行（照 TradingView：月亮 + 價格 + 相對正規盤收盤的漲跌）
                  <span className="ws-ext" title={EXT_NAME[qt.ext.src]}>
                    <Icon name={qt.ext.src === "pre" ? "sun" : "moon"} size={14} />
                    <b>{fmtP(qt.ext.p)}</b>
                    <i className={qt.ext.chg >= 0 ? "up" : "down"}>
                      {`${qt.ext.abs >= 0 ? "+" : "−"}${fmtP(Math.abs(qt.ext.abs))} ${qt.ext.chg >= 0 ? "+" : "−"}${Math.abs(qt.ext.chg).toFixed(2)}%`}
                    </i>
                    {qt.ext.src === "token" && <em>代幣</em>}
                  </span>
                )}
              </button>
              {(q || edit) && (
                <button className={`ws-act${inList(s) ? " in" : ""}`} aria-label={inList(s) ? `移除 ${s.symbol}` : `加入 ${s.symbol}`}
                  onClick={() => onToggle(s)}><Icon name={inList(s) ? (q ? "star" : "trash") : "plus"} size={20} /></button>
              )}
              {edit && !q && (
                <span className="ws-grip" aria-label={`拖動排序 ${s.symbol}`}
                  onPointerDown={(e) => { e.stopPropagation(); ds.start(i, e, true); }}><Icon name="list" size={20} /></span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── 繪圖工具 ──
const DRAW_SECTIONS: { id: string; title: string; tools: [Kind, string][] }[] = [
  { id: "line", title: "趨勢線工具", tools: [["ext", "延長線"], ["hray", "水平射線"], ["hline", "水平線"], ["vline", "垂直線"], ["ray", "射線"], ["channel", "平行通道"], ["trend", "趨勢線"]] },
  { id: "fib", title: "江恩和斐波那契", tools: [["fib", "斐波那契回撤"], ["fibext", "斐波那契延伸"]] },
  { id: "measure", title: "預測和測量", tools: [["long", "多頭倉位"], ["short", "空頭倉位"], ["frvp", "固定範圍成交量分佈圖"], ["prange", "價格範圍"], ["drange", "日期範圍"], ["measure", "價格與日期範圍"]] },
  { id: "shape", title: "圖形和文字", tools: [["rect", "矩形"], ["text", "文字"], ["plabel", "價格標籤"], ["arrowup", "向上箭頭"], ["arrowdown", "向下箭頭"]] },
];
export const TOOL_NAME: Record<string, string> = Object.fromEntries(DRAW_SECTIONS.flatMap((s) => s.tools));

export function DrawSheet({ s, set, onTool, onClose }: {
  s: Settings; set(p: Partial<Settings>): void; onTool(t: Tool): void; onClose(): void;
}) {
  const [tab, setTab] = useState("fav");
  const body = useRef<HTMLDivElement>(null);
  const fav = (k: Kind) => s.favTools.includes(k);
  const go = (id: string) => {
    setTab(id);
    if (id !== "fav") requestAnimationFrame(() => body.current?.querySelector(`#ds-${id}`)?.scrollIntoView({ block: "start" }));
  };
  const sections = DRAW_SECTIONS.map((sec) => ({ ...sec, tools: tab === "fav" ? sec.tools.filter(([k]) => fav(k)) : sec.tools }))
    .filter((sec) => sec.tools.length);
  return (
    <Sheet title="繪圖" onClose={onClose} head={
      <div className="tabs">
        <button className={tab === "fav" ? "on" : ""} onClick={() => go("fav")}>收藏</button>
        {DRAW_SECTIONS.map((sec) => (
          <button key={sec.id} className={tab === sec.id ? "on" : ""} onClick={() => go(sec.id)}>{sec.title}</button>
        ))}
      </div>
    } foot={
      <div className="m-toggle">
        <Icon name="edit" size={22} /><span>在圖表上顯示收藏</span>
        <button className={`switch${s.showFav ? " on" : ""}`} role="switch" aria-checked={s.showFav} aria-label="在圖表上顯示收藏"
          onClick={() => set({ showFav: !s.showFav })}><i /></button>
      </div>
    }>
      <div ref={body}>
        {sections.map((sec) => (
          <section key={sec.id} id={`ds-${sec.id}`} className="ds-sec">
            <h3>{sec.title}</h3>
            <div className="ds-grid">
              {sec.tools.map(([k, name]) => (
                <div key={k} className="ds-card">
                  <button className="ds-pick" onClick={() => { onTool(k); onClose(); }}>
                    <Icon name={k} size={24} /><span>{name}</span>
                  </button>
                  <button className={`ds-star${fav(k) ? " on" : ""}`} aria-pressed={fav(k)} aria-label={`收藏 ${name}`}
                    onClick={() => set({ favTools: fav(k) ? s.favTools.filter((x) => x !== k) : [...s.favTools, k] })}>
                    <Icon name="star" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
        {!sections.length && <p className="m-empty">還沒有收藏的工具，到其他分頁按星號加入</p>}
      </div>
    </Sheet>
  );
}

// ── 時間週期 ──
const IV_GROUPS: [string, string[]][] = [["分鐘", ["1m", "3m", "5m", "15m", "30m"]], ["小時", ["1h", "2h", "4h"]], ["天", ["1d", "1w", "1M"]]];

export function IntervalSheet({ iv, ivs, s, set, onIv, onSpan, onClose }: {
  iv: string; ivs: string[]; s: Settings; set(p: Partial<Settings>): void; onIv(iv: string): void; onSpan(label: string): void;
  onClose(): void;
}) {
  const press = useRef<{ id: number; fired: boolean } | null>(null);
  const [hint, setHint] = useState(true);
  const fav = (x: string) => s.favIvs.includes(x);
  const chip = (x: string) => (
    <button key={x} className={`iv-chip${iv === x ? " on" : ""}`}
      onPointerDown={() => {   // 長按 = 加入 / 移出收藏
        const p = { fired: false, id: window.setTimeout(() => {
          p.fired = true;
          set({ favIvs: fav(x) ? s.favIvs.filter((y) => y !== x) : [...s.favIvs, x] });
        }, 480) };
        press.current = p;
      }}
      onPointerUp={() => { const p = press.current; if (p) clearTimeout(p.id); if (p && !p.fired) { onIv(x); onClose(); } press.current = null; }}
      onPointerLeave={() => { if (press.current) clearTimeout(press.current.id); press.current = null; }}
      onContextMenu={(e) => e.preventDefault()}>
      {IV_SHORT[x]}{fav(x) && <Icon name="star" size={11} />}
    </button>
  );
  return (
    <Sheet title="日期範圍" onClose={onClose}>
      <div className="iv-row spans-row">
        {SPANS.map((sp) => <button key={sp.label} className="iv-chip" onClick={() => { onSpan(sp.label); onClose(); }}>{sp.label.replace("日", "天")}</button>)}
      </div>
      <h2 className="iv-h2">時間週期</h2>
      {hint && (
        <div className="iv-hint">
          <Icon name="star" size={24} /><span>長按將時間週期加入您的收藏</span>
          <button aria-label="關閉提示" onClick={() => setHint(false)}><Icon name="close" size={16} /></button>
        </div>
      )}
      <h3 className="iv-h3">收藏</h3>
      <div className="iv-row">{ivs.filter(fav).map(chip)}{!ivs.some(fav) && <span className="m-dim">還沒有收藏</span>}</div>
      {IV_GROUPS.map(([name, list]) => {
        const have = list.filter((x) => ivs.includes(x));
        return have.length ? (
          <div key={name}><h3 className="iv-h3">{name}</h3><div className="iv-row">{have.map(chip)}</div></div>
        ) : null;
      })}
    </Sheet>
  );
}

// ── 指標、更多 ──
export function IndicatorSheet({ s, set, onClose }: { s: Settings; set(p: Partial<Settings>): void; onClose(): void }) {
  return <Sheet title="指標" onClose={onClose}><IndicatorList s={s} set={set} /></Sheet>;
}

export function MoreSheet({ s, set, hidden, count, canRedo, inWatch, onHidden, onRedo, onClear, onWatch, onAlerts, onClose }: {
  s: Settings; set(p: Partial<Settings>): void; hidden: boolean; count: number; canRedo: boolean; inWatch: boolean;
  onHidden(): void; onRedo(): void; onClear(): void; onWatch(): void; onAlerts(): void; onClose(): void;
}) {
  const sw = (label: string, on: boolean, toggle: () => void, icon: string) => (
    <div className="more-row">
      <Icon name={icon} size={22} /><span>{label}</span>
      <button className={`switch${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={toggle}><i /></button>
    </div>
  );
  const act = (label: string, fn: () => void, icon: string, disabled = false, danger = false) => (
    <button className={`more-row${danger ? " danger" : ""}`} disabled={disabled} onClick={() => { fn(); onClose(); }}>
      <Icon name={icon} size={22} /><span>{label}</span>
    </button>
  );
  return (
    <Sheet title="更多" onClose={onClose}>
      <div className="more-list">
        {act(inWatch ? "從觀察清單移除" : "加入觀察清單", onWatch, inWatch ? "trash" : "plus")}
        <div className="more-row">
          <Icon name={s.chartType === "line" ? "lineChart" : "candle"} size={22} /><span>圖表類型</span>
          <div className="seg tiny" role="radiogroup" aria-label="圖表類型">
            {([["candle", "K 線"], ["line", "折線"]] as const).map(([t, n]) => (
              <button key={t} role="radio" aria-checked={s.chartType === t} className={s.chartType === t ? "on" : ""}
                onClick={() => set({ chartType: t })}>{n}</button>
            ))}
          </div>
        </div>
        {act("價格提醒", onAlerts, "alarm")}
        {sw("磁鐵（吸附開高低收）", s.magnet, () => set({ magnet: !s.magnet }), "magnet")}
        {sw("對數座標", s.log, () => set({ log: !s.log }), "indicator")}
        {sw("隱藏所有圖形", hidden, onHidden, "eyeOff")}
        {sw("價格軸自動調整高度（A）", s.autoScale, () => set({ autoScale: !s.autoScale }), "end")}
        {act("重做", onRedo, "redo", !canRedo)}
        {act(`刪除這個商品的所有圖形（${count}）`, onClear, "trash", !count, true)}
      </div>
    </Sheet>
  );
}

// ── 圖表上的收藏工具列（繪圖頁打開「在圖表上顯示收藏」才出現）──
export function FavBar({ tools, tool, onTool }: { tools: Kind[]; tool: Tool; onTool(t: Tool): void }) {
  if (!tools.length) return null;
  return (
    <nav className="m-fav" aria-label="收藏的繪圖工具">
      {tools.map((k) => (
        <button key={k} className={tool === k ? "on" : ""} aria-pressed={tool === k} aria-label={TOOL_NAME[k]}
          onClick={() => onTool(tool === k ? "cursor" : k)}><Icon name={k} size={22} /></button>
      ))}
    </nav>
  );
}
