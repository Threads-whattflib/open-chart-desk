import { useCallback, useEffect, useRef, useState } from "react";
import { getState, putState } from "./api";
import { ChartPane, type ChartHandle } from "./chart/ChartPane";
import type { DrawState } from "./draw/controller";
import { DEFAULT_SETTINGS, DEFAULT_WATCH, IV_LABEL, IV_SHORT, symKey, type Kind, type Settings, type Sym, type Tool } from "./types";
import { Icon, SymIcon } from "./ui/icons";
import { DrawSheet, FavBar, IndicatorSheet, IntervalSheet, MARKET_ORDER, MoreSheet, TOOL_NAME, WatchSheet, Wheel } from "./ui/mobile";
import { moveItem } from "./ui/dragSort";
import { displayOrder } from "./ui/watchGroups";
import { IndicatorPanel, SymbolSearch } from "./ui/panels";
import { DESK_IV, FloatFav, IvInput, ToolRail, WatchPanel, groupOf, parseIv } from "./ui/desktop";

const CRYPTO_IVS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
const STOCK_IVS = ["1m", "5m", "15m", "30m", "1h", "1d", "1w", "1M"];
const ivsOf = (s: Sym) => (s.market === "crypto" ? CRYPTO_IVS : STOCK_IVS);

// 手機直式，或橫放的手機（觸控 + 高度很矮）→ 用手機版面
const MOBILE_MQ = "(max-width: 640px), (pointer: coarse) and (max-height: 520px)";
function useMobile() {
  const [m, setM] = useState(() => window.matchMedia(MOBILE_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

type MSheet = null | "watch" | "iv" | "draw" | "ind" | "more";

export default function App() {
  const mobile = useMobile();
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [watch, setWatch] = useState<Sym[]>(DEFAULT_WATCH);
  const [sym, setSym] = useState<Sym>(DEFAULT_WATCH[0]);
  const [iv, setIv] = useState("1d");
  const [tool, setTool] = useState<Tool>("cursor");
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [search, setSearch] = useState<{ mode: "switch" | "add"; initial: string } | null>(null);
  const [indOpen, setIndOpen] = useState(false);
  const [sheet, setSheet] = useState<MSheet>(null);
  const [bare, setBare] = useState(false);          // 手機：收起下方列，圖表全螢幕
  const [ivText, setIvText] = useState<string | null>(null);   // 電腦：直接打數字換週期（打到一半的字）
  const chart = useRef<ChartHandle>(null);

  // 啟動：從伺服器讀上次的設定與自選清單（換裝置也一樣）
  // 讀失敗（伺服器重啟中、網路斷一下）就重試，讀到之前 ready 維持 false、不存檔，免得用預設值蓋掉伺服器上的清單
  useEffect(() => {
    let dead = false, timer = 0;
    const load = (wait: number) => Promise.all([getState<Settings>("settings"), getState<Sym[]>("watchlist")])
      .then(([s, w]) => {
        if (dead) return;
        if (s) {
          const merged = { ...DEFAULT_SETTINGS, ...s };
          if (window.innerWidth <= 860) merged.watchOpen = false;
          setSettings(merged);
          if (s.last?.sym) { setSym(s.last.sym); setIv(ivsOf(s.last.sym).includes(s.last.iv) ? s.last.iv : "1d"); }
        } else if (window.innerWidth <= 860) setSettings((x) => ({ ...x, watchOpen: false }));
        if (Array.isArray(w)) setWatch(w);
        setReady(true);
      }, (e) => {
        console.warn("讀設定 / 觀察清單失敗，稍後重試：", e);
        if (!dead) timer = window.setTimeout(() => load(Math.min(wait * 2, 30000)), wait);
      });
    load(2000);
    return () => { dead = true; clearTimeout(timer); };
  }, []);

  // 設定、自選有變就存回伺服器（延遲一下，避免連續操作時一直寫）
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => { putState("settings", { ...settings, last: { sym, iv } }).catch(() => {}); }, 600);
    return () => clearTimeout(id);
  }, [ready, settings, sym, iv]);
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => { putState("watchlist", watch).catch(() => {}); }, 600);
    return () => clearTimeout(id);
  }, [ready, watch]);

  // 電腦版週期列太窄要橫向捲動時，把選中的那個捲進畫面
  useEffect(() => {
    document.querySelector(".ivs button.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [iv, ready, sym.market]);

  useEffect(() => { document.title = `${sym.symbol} · ${IV_LABEL[iv]} — open-chart-desk`; }, [sym, iv]);

  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);
  const pickSym = useCallback((s: Sym) => {
    setSym(s);
    setIv((cur) => (ivsOf(s).includes(cur) ? cur : "1h"));
    setTool("cursor");
  }, []);
  const moveWatch = useCallback((from: number, to: number) => setWatch((w) => moveItem(w, from, to)), []);
  const toggleWatch = useCallback((s: Sym) => {
    setWatch((w) => (w.some((x) => symKey(x) === symKey(s)) ? w.filter((x) => symKey(x) !== symKey(s)) : [...w, s]));
  }, []);

  // 選工具時記住它是那一組上次用的（左側工具列那組的按鈕就顯示它，照 TradingView）
  const pickTool = useCallback((t: Tool) => {
    setTool(t);
    const g = t !== "cursor" ? groupOf(t as Kind) : undefined;
    if (g) setSettings((x) => (x.toolLast[g.id] === t ? x : { ...x, toolLast: { ...x.toolLast, [g.id]: t as Kind } }));
  }, []);

  // 電腦版鍵盤（照 TradingView）：
  // 打數字 = 換週期（15 Enter = 15 分、4h、1d、W…）；打字母 = 搜尋商品；Alt+T/H/J/V/F、Alt+Shift+R = 畫圖工具；
  // Alt+R = 重設圖表視圖；← → 平移、↑ ↓ 縮放
  const ivAllRef = useRef<string[]>([]);
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (search || indOpen || document.querySelector(".sheet-back, .ctx")) return;
      if (ivText != null) {
        e.preventDefault();
        if (e.key === "Escape") setIvText(null);
        else if (e.key === "Enter") { const v = parseIv(ivText, ivAllRef.current); if (v) setIv(v); setIvText(null); }
        else if (e.key === "Backspace") setIvText(ivText.length > 1 ? ivText.slice(0, -1) : null);
        else if (/^[0-9a-zA-Z]$/.test(e.key) && ivText.length < 4) setIvText(ivText + e.key);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const k = e.code.replace("Key", "");
        const t = e.shiftKey ? ({ R: "rect" } as Record<string, Tool>)[k]
          : ({ T: "trend", H: "hline", J: "hray", V: "vline", F: "fib" } as Record<string, Tool>)[k];
        if (t) { e.preventDefault(); pickTool(t); }
        else if (k === "R" && !e.shiftKey) { e.preventDefault(); chart.current?.resetView(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); chart.current?.scrollBars(e.key === "ArrowLeft" ? -3 : 3); return; }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); chart.current?.zoom(e.key === "ArrowUp" ? 0.85 : 1.18); return; }
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setIvText(e.key); return; }
      if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); setSearch({ mode: "switch", initial: e.key.toUpperCase() }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, indOpen, mobile, ivText, pickTool]);

  const onPickSearch = (s: Sym) => {
    if (search?.mode === "add") {
      setWatch((w) => (w.some((x) => symKey(x) === symKey(s)) ? w : [...w, s]));
    } else pickSym(s);
    setSearch(null);
  };

  const inWatch = watch.some((x) => symKey(x) === symKey(sym));
  // 手機：商品膠囊與週期膠囊都是滾輪，滾到停下來才切換。目前商品不在觀察清單時排在最前面
  // 只滾目前分頁（市場）的商品；那一頁是空的就滾全部
  // 照清單頁畫面的順序（市場 → 族群 → 商品）
  const tabWatch = displayOrder(watch, MARKET_ORDER.filter((mk) => settings.watchTab === "all" || mk === settings.watchTab));
  const wheelList = tabWatch.length ? tabWatch : watch;
  const symWheel = wheelList.some((x) => symKey(x) === symKey(sym)) ? wheelList : [sym, ...wheelList];
  const ivAll = ivsOf(sym);
  ivAllRef.current = ivAll;
  const ivWheel = ivAll.filter((x) => settings.favIvs.includes(x) || x === iv);
  const clearAll = () => { if (window.confirm(`刪除 ${sym.symbol} 的所有圖形？（可以用復原救回）`)) chart.current?.clearAll(); };
  if (!ready) return <div className="boot">載入中…</div>;

  const pane = (
    <ChartPane key={mobile ? "m" : "d"} ref={chart} sym={sym} iv={iv} settings={settings} tool={tool} mobile={mobile}
      onToolDone={() => setTool("cursor")} onDrawState={setDraw} onIv={setIv} onPatch={patch}
      onName={(name) => setSym((s) => (s.name === name || s.market !== "tw" ? s : { ...s, name }))} />
  );

  if (mobile) {
    return (
      <div className={`mapp${bare ? " bare" : ""}`}>
        <div className="m-chart">
          {pane}
          <button className="m-round m-bare" aria-label={bare ? "顯示工具列" : "收起工具列"} aria-pressed={bare} onClick={() => setBare(!bare)}>
            <Icon name={bare ? "chevron" : "chevronDown"} size={22} />
          </button>
          {draw?.canUndo && tool === "cursor" && (
            <button className="m-round m-undo" aria-label="復原" onClick={() => chart.current?.undo()}><Icon name="undo" size={20} /></button>
          )}
          {tool !== "cursor" && (
            <div className="m-hint">
              <Icon name={tool} size={18} /><span>{TOOL_NAME[tool]}：拖曳移動十字，點一下放置</span>
              <button onClick={() => setTool("cursor")}>取消</button>
            </div>
          )}
          {settings.showFav && !bare && <FavBar tools={settings.favTools} tool={tool} onTool={setTool} />}
        </div>

        {!bare && (
          <nav className="m-bar" aria-label="圖表控制">
            <div className="m-pill grow">
              <Wheel className="m-sym" label={`商品，目前 ${sym.symbol}；上下滾動切換，點一下開觀察清單`} items={symWheel}
                index={symWheel.findIndex((x) => symKey(x) === symKey(sym))} onPick={(i) => pickSym(symWheel[i])}
                onTap={() => setSheet("watch")} render={(s) => <><SymIcon sym={s} size={36} /><b>{s.symbol}</b></>} />
              <Wheel className="m-iv" label={`時間週期，目前 ${IV_LABEL[iv]}；上下滾動切換，點一下開週期頁`} items={ivWheel}
                index={ivWheel.indexOf(iv)} onPick={(i) => setIv(ivWheel[i])} onTap={() => setSheet("iv")}
                render={(x) => <b>{IV_SHORT[x]}</b>} />
            </div>
            <div className="m-pill">
              <button aria-label="繪圖工具" className={tool !== "cursor" ? "on" : ""} onClick={() => setSheet("draw")}><Icon name="pen" size={22} /></button>
              <button aria-label={settings.chartType === "line" ? "目前折線，點一下換 K 線" : "目前 K 線，點一下換折線"}
                onClick={() => patch({ chartType: settings.chartType === "line" ? "candle" : "line" })}>
                <Icon name={settings.chartType === "line" ? "lineChart" : "candle"} size={22} /></button>
              <button aria-label="指標" onClick={() => setSheet("ind")}><Icon name="fx" size={22} /></button>
              <button aria-label="更多" onClick={() => setSheet("more")}><Icon name="more" size={22} /></button>
            </div>
          </nav>
        )}

        {sheet === "watch" && (
          <WatchSheet items={watch} current={sym} onPick={(s) => { pickSym(s); setSheet(null); }} onToggle={toggleWatch}
            onMove={moveWatch} onEdit={setWatch} tab={settings.watchTab} onTab={(t) => patch({ watchTab: t })} onClose={() => setSheet(null)} />
        )}
        {sheet === "iv" && (
          <IntervalSheet iv={iv} ivs={ivAll} s={settings} set={patch} onIv={setIv}
            onSpan={(label) => chart.current?.pickSpan(label)} onClose={() => setSheet(null)} />
        )}
        {sheet === "draw" && <DrawSheet s={settings} set={patch} onTool={pickTool} onClose={() => setSheet(null)} />}
        {sheet === "ind" && <IndicatorSheet s={settings} set={patch} onClose={() => setSheet(null)} />}
        {sheet === "more" && (
          <MoreSheet s={settings} set={patch} hidden={!!draw?.hidden} count={draw?.count ?? 0} canRedo={!!draw?.canRedo}
            inWatch={inWatch} onHidden={() => chart.current?.toggleHidden()}
            onRedo={() => chart.current?.redo()} onClear={clearAll} onWatch={() => toggleWatch(sym)}
            onAlerts={() => chart.current?.openAlerts()} onClose={() => setSheet(null)} />
        )}
      </div>
    );
  }

  const favToggle = (k: Kind) => patch({ favTools: settings.favTools.includes(k) ? settings.favTools.filter((x) => x !== k) : [...settings.favTools, k] });
  return (
    <div className={`app${settings.watchOpen ? " watch-open" : ""}`}>
      <header className="top">
        <img className="logo" src="/logo.svg" alt="" width={26} height={26} />
        <button className="sym-box" onClick={() => setSearch({ mode: "switch", initial: "" })} title="切換商品（直接打字也可以）">
          <SymIcon sym={sym} size={18} />
          <b>{sym.symbol}</b>
          {sym.market === "tw" && <span>{sym.name}</span>}
        </button>
        <button className={`tb-ic${inWatch ? " star-on" : ""}`} aria-pressed={inWatch}
          aria-label={inWatch ? "從觀察清單移除" : "加入觀察清單"} title={inWatch ? "從觀察清單移除" : "加入觀察清單"}
          onClick={() => toggleWatch(sym)}><Icon name={inWatch ? "star" : "starLine"} size={18} /></button>
        <span className="top-sep" />
        <div className="ivs" role="tablist" aria-label="週期（直接打數字也可以，例如 15 Enter、4h Enter）">
          {ivAll.map((x) => (
            <button key={x} role="tab" aria-selected={iv === x} className={iv === x ? "on" : ""} title={IV_LABEL[x]} onClick={() => setIv(x)}>
              {DESK_IV[x]}
            </button>
          ))}
        </div>
        <span className="top-sep" />
        {(["candle", "line"] as const).map((t) => (
          <button key={t} className={`tb-ic${settings.chartType === t ? " on" : ""}`} aria-pressed={settings.chartType === t}
            aria-label={t === "candle" ? "K 線" : "折線"} title={t === "candle" ? "K 線" : "折線"}
            onClick={() => patch({ chartType: t })}><Icon name={t === "candle" ? "candle" : "lineChart"} size={22} /></button>
        ))}
        <span className="top-sep" />
        <button className="top-btn" onClick={() => setIndOpen(true)}><Icon name="indicator" size={20} /><span>技術指標</span></button>
        <span className="top-sep" />
        <button className="tb-ic" disabled={!draw?.canUndo} aria-label="復原" title="復原（Ctrl+Z）"
          onClick={() => chart.current?.undo()}><Icon name="undo" size={20} /></button>
        <button className="tb-ic" disabled={!draw?.canRedo} aria-label="重做" title="重做（Ctrl+Shift+Z）"
          onClick={() => chart.current?.redo()}><Icon name="redo" size={20} /></button>
        <span className="top-fill" />
        <button className="tb-ic" aria-label="全螢幕" title="全螢幕"
          onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}>
          <Icon name="full" size={20} /></button>
      </header>

      <ToolRail tool={tool} onTool={pickTool} last={settings.toolLast} fav={settings.favTools} onFav={favToggle}
        magnet={settings.magnet} onMagnet={() => patch({ magnet: !settings.magnet })}
        hidden={!!draw?.hidden} onHidden={() => chart.current?.toggleHidden()} count={draw?.count ?? 0} onClear={clearAll}
        deskFav={settings.deskFav} onDeskFav={() => patch({ deskFav: !settings.deskFav })} />

      <div className="chart-cell">
        {pane}
        {settings.deskFav && <FloatFav tools={settings.favTools} tool={tool} onTool={pickTool} pos={settings.favPos} onPos={(p) => patch({ favPos: p })} />}
        {ivText != null && <IvInput text={ivText} ok={!!parseIv(ivText, ivAll)} />}
      </div>

      <div className="side">
        {settings.watchOpen && (
          <WatchPanel items={watch} current={sym} tab={settings.watchTab} onTab={(t) => patch({ watchTab: t })}
            onPick={(s) => { pickSym(s); if (window.innerWidth <= 860) patch({ watchOpen: false }); }}
            onEdit={setWatch} onMove={moveWatch} onAdd={() => setSearch({ mode: "add", initial: "" })}
            onClose={() => patch({ watchOpen: false })} detail={settings.detailOpen} onDetail={() => patch({ detailOpen: !settings.detailOpen })} />
        )}
        <nav className="strip" aria-label="側邊面板">
          <button className={`strip-btn${settings.watchOpen ? " on" : ""}`} aria-pressed={settings.watchOpen} aria-label="觀察清單"
            title="觀察清單" onClick={() => patch({ watchOpen: !settings.watchOpen })}><Icon name="watchIc" size={24} /></button>
        </nav>
      </div>

      {search && (
        <SymbolSearch initial={search.initial} title={search.mode === "add" ? "加入觀察清單" : "切換商品"}
          onPick={onPickSearch} onClose={() => setSearch(null)} />
      )}
      {indOpen && <IndicatorPanel s={settings} set={patch} onClose={() => setIndOpen(false)} />}
    </div>
  );
}
