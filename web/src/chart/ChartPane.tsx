import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, TickMarkType,
  createChart, type IChartApi, type IPriceLine, type ISeriesApi, type SeriesType, type Time,
} from "lightweight-charts";
import { createAlert, deleteAlert, fetchAlerts, fetchBars, fetchDrawings, liveKline, saveDrawings, type Alert } from "../api";
import { DrawController, type DrawState } from "../draw/controller";
import { DrawLayer } from "../draw/layer";
import { IV_LABEL, IV_SEC, IV_SHORT, MARKET_LABEL, type Bar, type Drawing, type Settings, type Sym, type Tool } from "../types";
import { bollinger, ema, macd, rsi, sma, type Series } from "./indicators";
import { DrawingSettings } from "../ui/drawSettings";
import { Icon, SymIcon } from "../ui/icons";
import { Clock, CtxMenu, DrawBar, type MenuItem } from "../ui/desktop";
import { AlertCreate, AlertList, PlusSheet } from "../ui/alerts";

/* 圖表引擎：TradingView Lightweight Charts（Apache-2.0，保留右下角 attribution logo）。
   操作：拖曳平移、滾輪 / 雙指縮放、拖價格軸與時間軸縮放、雙擊價格軸回自動、往左拖自動補歷史。 */

// 電腦版顏色：圖表底 #0f0f0f、分隔線 #222
const C = {
  bg: "#0f0f0f", text: "#b8b8b8", grid: "#1a1a1a", border: "#222222", up: "#16c784", down: "#ff4d4d",
  cross: "#8c8c8c", label: "#363636",
};
const ALERT_COLOR = "#ff7a45";  // 價格提醒線
const LINE_COLOR = "#8840ea";   // 折線圖（紫色）
// 手機版照 TradingView app：近黑底、格線極淡、座標用系統字
const CM = { bg: "#0b0b0c", text: "#c7c7cc", grid: "#141416", border: "#0b0b0c", cross: "#9a9a9a", label: "#3a3a3c" };   // 十字線：灰色虛線
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
const MA_COLORS = ["#f5b83d", "#4f8dff", "#c77dff", "#2bb3a3", "#ff7a59"];
const WEEK = "日一二三四五六";
export const SPANS: { label: string; sec: number; crypto: string; stock: string }[] = [
  { label: "1天", sec: 86400, crypto: "5m", stock: "5m" },
  { label: "5天", sec: 5 * 86400, crypto: "15m", stock: "15m" },
  { label: "1月", sec: 30 * 86400, crypto: "1h", stock: "1h" },
  { label: "3月", sec: 91 * 86400, crypto: "4h", stock: "1h" },
  { label: "6月", sec: 182 * 86400, crypto: "1d", stock: "1d" },
  { label: "1年", sec: 365 * 86400, crypto: "1d", stock: "1d" },
  { label: "5年", sec: 5 * 365 * 86400, crypto: "1w", stock: "1w" },
  { label: "全部", sec: 0, crypto: "1M", stock: "1M" },
];

export interface ChartHandle {
  undo(): void; redo(): void; clearAll(): void; toggleHidden(): void; pickSpan(label: string): void; autoScale(): void;
  resetView(): void; scrollBars(n: number): void; zoom(k: number): void; openAlerts(): void;
}

interface Props {
  sym: Sym;
  iv: string;
  settings: Settings;
  tool: Tool;
  mobile?: boolean;
  onToolDone(): void;
  onDrawState(s: DrawState): void;
  onIv(iv: string): void;
  onPatch(p: Partial<Settings>): void;
  onName(name: string): void;
}

interface Ind { series: ISeriesApi<SeriesType>; label: string; color: string; hist?: boolean; compute(b: Bar[]): Series; values: Series }

// 手機圖例上一個指標一列：名稱 + 數值 + 隱藏鈕
type GroupKey = "ma" | "bb" | "rsi" | "macd";
const GROUPS: { key: GroupKey; name(s: Settings): string; match(label: string): boolean }[] = [
  { key: "ma", name: (s) => `${s.ma.type === "EMA" ? "EMA" : "MA"} ${s.ma.periods.join(" ")}`, match: (l) => /^(MA|EMA)\d/.test(l) },
  { key: "bb", name: (s) => `BB ${s.bb.n} ${s.bb.k}`, match: (l) => l.startsWith("BB") },
  { key: "rsi", name: (s) => `RSI ${s.rsi.n}`, match: (l) => l.startsWith("RSI") },
  { key: "macd", name: (s) => `MACD ${s.macd.fast} ${s.macd.slow} ${s.macd.signal}`, match: (l) => l === "MACD" || l === "訊號" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const precision = (p: number) => (p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 6);
const fmtVol = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M`
  : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(v >= 10 ? 0 : 2));

export const ChartPane = forwardRef<ChartHandle, Props>(function ChartPane(
  { sym, iv, settings, tool, mobile = false, onToolDone, onDrawState, onIv, onPatch, onName }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);     // 最新價 + 收盤倒數標籤（蓋在價格軸上）
  const aBtn = useRef<HTMLButtonElement>(null);     // 價格軸右下的 A（自動調整高度）
  const auto = useRef({ on: settings.autoScale, fitting: false, patch: onPatch });
  auto.current.on = settings.autoScale; auto.current.patch = onPatch;
  const [cfg, setCfg] = useState(false);            // 圖形設定頁（在圖形上連點兩下）
  const [fold, setFold] = useState(() => window.innerHeight < 520);   // 手機：圖例收合（橫放預設收起，不然蓋住圖）
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const typeRef = useRef(settings.chartType);
  typeRef.current = settings.chartType;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // 價格提醒：十字線價格旁的 ⊕（電腦滑鼠移到價格附近、手機長按出十字線），提醒畫成價格線
  const plusRef = useRef<HTMLButtonElement>(null);
  const plus = useRef({ price: 0, over: false, timer: 0 });
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertErr, setAlertErr] = useState("");
  const [alertNew, setAlertNew] = useState<number | null>(null);
  const [alertList, setAlertList] = useState(false);
  const [plusSheet, setPlusSheet] = useState<number | null>(null);
  const alertLines = useRef<IPriceLine[]>([]);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const layerRef = useRef<DrawLayer | null>(null);
  const ctrlRef = useRef<DrawController | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const moreRef = useRef(false);
  const busyRef = useRef(false);
  const indRef = useRef<Ind[]>([]);
  const wantRange = useRef<{ from: number; to: number } | null>(null);   // 載入後要顯示的範圍；指標重建後再套一次
  const ctx = useRef({ sym, iv, seq: 0, span: null as number | null });   // span = 下次載入後要顯示的時間長度
  ctx.current.sym = sym; ctx.current.iv = iv;
  const prevIv = useRef<typeof iv | null>(null);   // 上一次載入的週期：判斷這次是換商品還是換週期
  const cbs = useRef({ onToolDone, onDrawState, onName });
  cbs.current = { onToolDone, onDrawState, onName };
  const savePending = useRef<{ sym: Sym; items: Drawing[]; timer: number } | null>(null);
  // 這個商品的畫線已經從伺服器讀到了沒（market:symbol）。沒讀到前不存檔，不然會用空清單蓋掉伺服器上的畫線
  const drawLoaded = useRef<string | null>(null);

  const [ver, setVer] = useState(0);            // K 棒資料換了（載入 / 補歷史）→ 重算指標
  const [, setTick] = useState(0);              // 即時更新時重畫圖例
  const [hover, setHover] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [edit, setEdit] = useState<{ id: string; x: number; y: number; value: string } | null>(null);
  const [saved, setSaved] = useState<"" | "儲存中" | "已儲存" | "儲存失敗" | "畫線讀取中，變更不會儲存">("");

  const flushSave = useCallback(() => {
    const p = savePending.current;
    if (!p) return;
    clearTimeout(p.timer);
    savePending.current = null;
    setSaved("儲存中");
    saveDrawings(p.sym.market, p.sym.symbol, p.items).then(() => setSaved("已儲存"), () => setSaved("儲存失敗"));
  }, []);

  // ── 建立圖表（只做一次）──
  useEffect(() => {
    const el = box.current!;
    const intraday = () => IV_SEC[ctx.current.iv] < 86400;
    // 盤中 K 用瀏覽器當地時間顯示；日 K 以上的時間戳是 UTC 午夜，用 UTC 取日期才不會差一天
    const parts = (t: number) => {
      const d = new Date(t * 1000), loc = intraday();
      return {
        y: loc ? d.getFullYear() : d.getUTCFullYear(), m: (loc ? d.getMonth() : d.getUTCMonth()) + 1,
        d: loc ? d.getDate() : d.getUTCDate(), hh: d.getHours(), mm: d.getMinutes(), wd: loc ? d.getDay() : d.getUTCDay(),
      };
    };
    const K = mobile ? { ...C, ...CM } : C;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: K.bg }, textColor: K.text, fontFamily: mobile ? SANS : MONO,
        fontSize: mobile ? 12 : 11, attributionLogo: true,
        panes: { separatorColor: mobile ? "#1c1c1e" : C.border, separatorHoverColor: "#2f6bff33", enableResize: true },
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },   // 背景不畫格線
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: K.cross, style: LineStyle.Dashed, width: 1, labelBackgroundColor: K.label },
        horzLine: { color: K.cross, style: LineStyle.Dashed, width: 1, labelBackgroundColor: K.label },
      },
      handleScale: { pinch: false },   // 雙指縮放由 DrawController 自己做（優先於圖形、速度較快）
      rightPriceScale: { borderColor: K.border, scaleMargins: { top: mobile ? 0.24 : 0.1, bottom: mobile ? 0.16 : 0.2 } },
      timeScale: {
        borderColor: K.border, rightOffset: mobile ? 5 : 8, minBarSpacing: 0.5, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const p = parts(time as number);
          if (type === TickMarkType.Year) return String(p.y);
          if (type === TickMarkType.Month) return `${p.m}月`;
          if (type === TickMarkType.DayOfMonth) return `${p.m}/${p.d}`;
          return `${pad(p.hh)}:${pad(p.mm)}`;
        },
      },
      localization: {
        locale: "zh-TW",
        timeFormatter: (time: Time) => {
          const p = parts(time as number);
          const date = `${p.y}/${pad(p.m)}/${pad(p.d)}`;
          return intraday() ? `${date} ${pad(p.hh)}:${pad(p.mm)}` : `${date}（${WEEK[p.wd]}）`;
        },
      },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
      lastValueVisible: false,   // 最新價標籤自己畫（要多一行收盤倒數）
    });
    // 折線模式：K 棒改透明（圖形圖層掛在 K 棒序列上，不能拿掉），另外畫收盤價折線
    const line = chart.addSeries(LineSeries, {
      color: LINE_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, visible: false,
      crosshairMarkerRadius: 4, crosshairMarkerBorderColor: LINE_COLOR, crosshairMarkerBackgroundColor: "#fff",
    });
    lineRef.current = line;
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const layer = new DrawLayer();
    candle.attachPrimitive(layer);
    const ctrl = new DrawController(el, chart, candle, layer, {
      onState: (s) => { setDraw(s); cbs.current.onDrawState(s); },
      onToolDone: () => cbs.current.onToolDone(),
      onChange: (items) => {
        const s = ctx.current.sym;
        if (drawLoaded.current !== `${s.market}:${s.symbol}`) { setSaved("畫線讀取中，變更不會儲存"); return; }
        if (savePending.current) clearTimeout(savePending.current.timer);
        savePending.current = { sym: ctx.current.sym, items, timer: window.setTimeout(flushSave, 500) };
      },
      onEditText: (d) => {
        const a = ctrl.anchor(d);
        if (a) setEdit({ id: d.id, x: a.x, y: a.y, value: d.text ?? "" });
      },
      onSettings: () => setCfg(true),
    });
    chartRef.current = chart; candleRef.current = candle; volRef.current = vol; layerRef.current = layer;
    ctrlRef.current = ctrl;

    chart.subscribeCrosshairMove((p) => {
      const pb = plusRef.current, g = plus.current;
      if (pb) {
        const y = p.point && (p.paneIndex ?? 0) === 0 && toolRef.current === "cursor" ? p.point.y : null;
        const pr = y != null ? candle.coordinateToPrice(y) : null;
        if (y != null && pr != null && y > 8 && y < layer.size.h - 8) {
          clearTimeout(g.timer);
          g.price = pr;
          pb.style.display = "grid"; pb.style.top = `${Math.round(y)}px`;
        } else if (!g.over) {
          clearTimeout(g.timer);   // 電腦：滑鼠從圖移到 ⊕ 上時十字線會先消失，留一下讓人點得到
          g.timer = window.setTimeout(() => { if (!plus.current.over) pb.style.display = "none"; }, mobile ? 0 : 250);
        }
      }
      if (p.time == null) { setHover(null); return; }
      const b = barsRef.current, t = p.time as number;
      let lo = 0, hi = b.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (b[m].t < t) lo = m + 1; else hi = m; }
      setHover(b[lo]?.t === t ? lo : null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r) return;
      setAtEnd(r.to >= barsRef.current.length - 1.5);
      if (r.from < 40 && moreRef.current && !busyRef.current && barsRef.current.length) loadMore();
    });

    // 往左拖到快沒資料時補更早的 K 棒；補完把可視範圍往右平移同樣根數，畫面不會跳
    const loadMore = () => {
      const { sym: s, iv: i, seq } = ctx.current;
      busyRef.current = true;
      fetchBars(s.market, s.symbol, i, barsRef.current[0].t).then(({ bars, more }) => {
        if (seq !== ctx.current.seq) return;
        const first = barsRef.current[0].t;
        const add = bars.filter((b) => b.t < first);
        moreRef.current = more && add.length > 0;
        if (!add.length) return;
        const r = chart.timeScale().getVisibleLogicalRange();
        barsRef.current = [...add, ...barsRef.current];
        pushData();
        if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + add.length, to: r.to + add.length });
        setVer((v) => v + 1);
      }).catch(() => { /* 補歷史失敗不影響已載入的圖，下次拖到邊再試 */ }).finally(() => { busyRef.current = false; });
    };

    // 最新價 + 這根 K 棒收盤倒數：每個畫面更新位置（跟著縮放 / 平移），內容有變才寫 DOM
    let raf = 0, prevTxt = "", prevTop = "";
    const tickLast = () => {
      raf = requestAnimationFrame(tickLast);
      // A 鈕貼在價格軸與時間軸交會的右下角；使用者拖價格軸時圖表會自己關掉自動，這裡把按鈕狀態同步回去
      const ab = aBtn.current, ps = chart.priceScale("right");
      if (ab) {
        const pos = `${el.clientHeight - chart.timeScale().height()}|${ps.width()}|${chart.timeScale().height()}`;
        if (ab.dataset.pos !== pos) {
          ab.dataset.pos = pos;
          ab.style.top = `${el.clientHeight - chart.timeScale().height()}px`; ab.style.width = `${ps.width()}px`;
          ab.style.height = `${chart.timeScale().height()}px`;
        }
      }
      const isAuto = ps.options().autoScale;
      if (!auto.current.fitting && isAuto !== auto.current.on) { auto.current.on = isAuto; auto.current.patch({ autoScale: isAuto }); }
      const tag = lastRef.current, b = barsRef.current, last = b[b.length - 1];
      if (!tag) return;
      const y = last ? candle.priceToCoordinate(last.c) : null;
      if (y == null || y < 0 || y > layer.size.h) { if (prevTop !== "hide") { tag.style.display = "none"; prevTop = "hide"; } return; }
      const { market } = ctx.current.sym, sec = IV_SEC[ctx.current.iv];
      let cd = "";
      if (market === "crypto" || sec < 86400) {   // 股票日 K 以上沒有固定的收盤秒數，不顯示倒數
        const left = last.t + sec - Math.floor(Date.now() / 1000);
        if (left > 0 && left <= sec) {
          const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60);
          cd = d ? `${d}天 ${pad(h)}時` : h ? `${pad(h)}:${pad(m)}:${pad(left % 60)}` : `${pad(m)}:${pad(left % 60)}`;
        }
      }
      const txt = `${candle.priceFormatter().format(last.c)}|${cd}|${last.c >= last.o ? 1 : 0}|${typeRef.current}`;
      if (txt !== prevTxt) {
        prevTxt = txt;
        tag.innerHTML = `<b>${candle.priceFormatter().format(last.c)}</b>${cd ? `<span>${cd}</span>` : ""}`;
        tag.style.background = typeRef.current === "line" ? "#2f6bff" : last.c >= last.o ? C.up : C.down;
      }
      const top = `${Math.round(y)}px|${chart.priceScale("right").width()}`;
      if (top !== prevTop) {
        prevTop = top;
        tag.style.display = "flex"; tag.style.top = `${Math.round(y)}px`; tag.style.width = `${chart.priceScale("right").width()}px`;
        el.parentElement?.style.setProperty("--axis-w", `${chart.priceScale("right").width()}px`);   // 給貼著價格軸的元件（MTF 表）用
      }
    };
    raf = requestAnimationFrame(tickLast);

    return () => { cancelAnimationFrame(raf); flushSave(); ctrl.destroy(); chart.remove(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushSave]);

  const pushData = () => {
    const b = barsRef.current;
    candleRef.current?.setData(b.map((x) => ({ time: x.t as Time, open: x.o, high: x.h, low: x.l, close: x.c })));
    lineRef.current?.setData(b.map((x) => ({ time: x.t as Time, value: x.c })));
    volRef.current?.setData(b.map((x) => ({
      time: x.t as Time, value: x.v, color: x.c >= x.o ? `${C.up}55` : `${C.down}55`,
    })));
    layerRef.current?.setBars(b);
  };

  const showSpan = (sec: number) => {
    const b = barsRef.current, ts = chartRef.current?.timeScale();
    if (!b.length || !ts) return;
    let r = { from: -2, to: b.length + 6 };
    if (sec) {
      const from = b[b.length - 1].t - sec;
      let i = b.findIndex((x) => x.t >= from);
      if (i < 0) i = 0;
      r = { from: i - 1, to: b.length + Math.max(2, (b.length - i) * 0.04) };
    }
    wantRange.current = r;
    ts.setVisibleLogicalRange(r);
  };

  // ── 換商品 / 週期：載入 K 棒、接即時更新 ──
  useEffect(() => {
    const chart = chartRef.current!, candle = candleRef.current!;
    const seq = ++ctx.current.seq;
    let stop: (() => void) | null = null;
    setLoading(true); setErr(null); setHover(null);
    chart.applyOptions({ timeScale: { timeVisible: IV_SEC[iv] < 86400 } });

    // 換之前先記下目前視野：
    // 顯示幾根一律保留；換商品時連時間位置也保留（右緣對到同一個時間），換週期則回到最新
    const ob = barsRef.current, r0 = chart.timeScale().getVisibleLogicalRange();
    let view: { count: number; off: number | null; t: number; frac: number; sameIv: boolean } | null = null;
    if (ob.length && r0 && prevIv.current != null) {
      const last = ob.length - 1, ri = Math.max(0, Math.min(last, Math.floor(r0.to)));
      view = {
        count: Math.max(10, r0.to - r0.from),
        off: r0.to >= last + 0.5 ? r0.to - last : null,   // 貼著最新 → 記右邊留白；否則 null
        t: ob[ri].t, frac: r0.to - ri, sameIv: prevIv.current === iv,
      };
    }
    prevIv.current = iv;

    let raf = 0, lastInd = 0;
    const onBar = (nb: Bar) => {
      if (seq !== ctx.current.seq) return;
      const b = barsRef.current, last = b[b.length - 1];
      if (!last || nb.t < last.t) return;
      if (nb.t === last.t) b[b.length - 1] = nb; else b.push(nb);
      const fresh = nb.t !== last.t;
      candle.update({ time: nb.t as Time, open: nb.o, high: nb.h, low: nb.l, close: nb.c });
      lineRef.current?.update({ time: nb.t as Time, value: nb.c });
      volRef.current?.update({ time: nb.t as Time, value: nb.v, color: nb.c >= nb.o ? `${C.up}55` : `${C.down}55` });
      layerRef.current?.setBars(b);
      const now = Date.now();
      if (fresh || now - lastInd > 1000) { lastInd = now; refreshIndicators(); }
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setTick((x) => x + 1); });
    };

    fetchBars(sym.market, sym.symbol, iv).then(({ bars, more, name }) => {
      if (seq !== ctx.current.seq) return;
      barsRef.current = bars; moreRef.current = more;
      const p = precision(bars[bars.length - 1].c);
      // 手機版價格加千分位（跟 TradingView app 一樣）
      candle.applyOptions({ priceFormat: mobile
        ? { type: "custom", minMove: 1 / 10 ** p, formatter: (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p }) }
        : { type: "price", precision: p, minMove: 1 / 10 ** p } });
      pushData();
      const span = ctx.current.span;
      ctx.current.span = null;
      if (span != null) showSpan(span);
      else if (view) {
        const last = bars.length - 1;
        let to = last + (view.off ?? (mobile ? 5 : 8));
        if (view.off == null && view.sameIv) {
          const j = bars.findIndex((x) => x.t > view.t);   // 第一根晚於原本右緣時間的
          if (j >= 0) to = j - 1 + view.frac;                 // 右緣對齊同一時間；j<0 = 新商品沒那麼新的資料 → 最新
        }
        let from = to - view.count;
        if (from < -2) { from = -2; to = from + view.count; }   // 資料不夠早 → 最舊那段（往左拖會自動補歷史）
        wantRange.current = { from, to };
        chart.timeScale().setVisibleLogicalRange(wantRange.current);
      } else {
        const n = bars.length, show = mobile ? 70 : 150;
        wantRange.current = { from: n - show, to: n + 6 };
        chart.timeScale().setVisibleLogicalRange(wantRange.current);
      }
      // 換商品 / 週期先自動對一次高度（不然 K 棒可能在畫面外）；A 沒開的話對完就固定住
      auto.current.fitting = true;
      chart.priceScale("right").applyOptions({ autoScale: true });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (seq !== ctx.current.seq) return;
        chart.priceScale("right").applyOptions({ autoScale: auto.current.on });
        auto.current.fitting = false;
      }));
      setVer((v) => v + 1);
      if (name) cbs.current.onName(name);
      if (sym.market === "crypto") stop = liveKline(sym.symbol, iv, onBar);
      else {
        // 股票沒有免費的即時串流：定期抓最後幾根（分頁在背景時不抓）。
        // 台股後端會用證交所 MIS 的即時價更新最後一根（約 5 秒一筆），所以抓密一點；美股 Yahoo 本身就有延遲，20 秒一次
        const id = window.setInterval(() => {
          if (document.hidden) return;
          fetchBars(sym.market, sym.symbol, iv, undefined, 3).then((r) => r.bars.forEach(onBar)).catch(() => {});
        }, sym.market === "tw" ? 5000 : 20000);
        stop = () => clearInterval(id);
      }
    }).catch((e: Error) => {
      if (seq !== ctx.current.seq) return;
      barsRef.current = []; pushData(); setErr(e.message || "載入失敗");
    }).finally(() => { if (seq === ctx.current.seq) setLoading(false); });

    return () => { stop?.(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym.market, sym.symbol, iv]);

  // ── 換商品：載入這個商品的圖形（換週期不重載）──
  useEffect(() => {
    flushSave();
    setSaved(""); setEdit(null);
    drawLoaded.current = null;
    ctrlRef.current?.load([]);
    let dead = false, timer = 0;
    const key = `${sym.market}:${sym.symbol}`;
    const load = (wait: number) => fetchDrawings(sym.market, sym.symbol).then((items) => {
      if (dead) return;
      ctrlRef.current?.load(items);
      drawLoaded.current = key;
      setSaved("");
    }, () => {   // 讀失敗：維持不存檔，稍後重試（讀到後會換成伺服器上的畫線）
      if (dead) return;
      setSaved("畫線讀取中，變更不會儲存");
      timer = window.setTimeout(() => load(Math.min(wait * 2, 30000)), wait);
    });
    load(2000);
    return () => { dead = true; clearTimeout(timer); };
  }, [sym.market, sym.symbol, flushSave]);

  // ── 指標 ──
  const toData = (ind: Ind, b: Bar[]) => ind.values.map((v, i) => (v == null ? { time: b[i].t as Time }
    : ind.hist ? { time: b[i].t as Time, value: v, color: v >= 0 ? `${C.up}aa` : `${C.down}aa` }
      : { time: b[i].t as Time, value: v }));
  const refreshIndicators = () => {
    const b = barsRef.current;
    for (const ind of indRef.current) { ind.values = ind.compute(b); ind.series.setData(toData(ind, b)); }
  };

  const { ma, bb, rsi: rsiS, macd: macdS } = settings;
  const indKey = JSON.stringify([ma, bb, rsiS, macdS]);
  useEffect(() => {
    const chart = chartRef.current!, b = barsRef.current;
    const keep = wantRange.current ?? chart.timeScale().getVisibleLogicalRange();
    wantRange.current = null;
    for (const ind of indRef.current) chart.removeSeries(ind.series);
    indRef.current = [];
    if (!b.length) return;
    const closes = (x: Bar[]) => x.map((k) => k.c);
    const line = (label: string, color: string, pane: number, compute: Ind["compute"], dashed = false) => {
      const series = chart.addSeries(LineSeries, {
        color, lineWidth: 1, lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false,
        lastValueVisible: pane > 0, crosshairMarkerVisible: false,
      }, pane);
      indRef.current.push({ series, label, color, compute, values: [] });
      return series;
    };
    if (ma.on) {
      ma.periods.forEach((n, i) => line(`${ma.type === "EMA" ? "EMA" : "MA"}${n}`, MA_COLORS[i % MA_COLORS.length], 0,
        (x) => (ma.type === "EMA" ? ema(closes(x), n) : sma(closes(x), n))));
    }
    if (bb.on) {
      line(`BB上`, "#5b9cf6", 0, (x) => bollinger(closes(x), bb.n, bb.k).up);
      line(`BB中`, "#5b9cf688", 0, (x) => bollinger(closes(x), bb.n, bb.k).mid, true);
      line(`BB下`, "#5b9cf6", 0, (x) => bollinger(closes(x), bb.n, bb.k).lo);
    }
    let pane = 1;
    if (rsiS.on) {
      const s = line(`RSI${rsiS.n}`, "#c77dff", pane++, (x) => rsi(closes(x), rsiS.n));
      for (const price of [70, 30]) {
        s.createPriceLine({ price, color: "#5b6170", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      }
    }
    if (macdS.on) {
      const m = (x: Bar[]) => macd(closes(x), macdS.fast, macdS.slow, macdS.signal);
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      indRef.current.push({ series: hist, label: "柱", color: C.text, hist: true, compute: (x) => m(x).hist, values: [] });
      line("MACD", "#4f8dff", pane, (x) => m(x).line);
      line("訊號", "#f5b83d", pane, (x) => m(x).sig);
    }
    refreshIndicators();
    // 主圖 : 每個副圖 = 5 : 1（手機 4 : 1）；使用者仍可拖分隔線調整
    const main = mobile ? 4 : 5;
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? main : 1));
    if (keep) chart.timeScale().setVisibleLogicalRange(keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, indKey]);

  useEffect(() => { volRef.current?.applyOptions({ visible: settings.vol }); }, [settings.vol]);
  const loadAlerts = useCallback(() => {
    const { market, symbol } = sym;
    fetchAlerts(market, symbol).then((r) => {
      if (ctx.current.sym.symbol !== symbol || ctx.current.sym.market !== market) return;
      setAlerts(r); setAlertErr("");
    }, (e: Error) => { setAlerts([]); setAlertErr(e.message); });
  }, [sym]);
  useEffect(() => {
    setAlerts([]);
    loadAlerts();
    const id = window.setInterval(() => { if (!document.hidden) loadAlerts(); }, 60000);   // 觸發後會被停用，定時刷掉
    return () => clearInterval(id);
  }, [loadAlerts]);
  useEffect(() => {
    const s = candleRef.current;
    if (!s) return;
    alertLines.current.forEach((l) => s.removePriceLine(l));
    alertLines.current = alerts.map((a) => s.createPriceLine({
      price: a.price, color: ALERT_COLOR, lineStyle: LineStyle.SparseDotted, lineWidth: 1,
      axisLabelVisible: true, axisLabelColor: ALERT_COLOR, axisLabelTextColor: "#111", title: `⏰ ${a.dir === "above" ? "↑" : "↓"}`,
    }));
  }, [alerts]);
  const lastClose = () => barsRef.current[barsRef.current.length - 1]?.c ?? 0;
  const fmtPrice = (v: number) => candleRef.current?.priceFormatter().format(v) ?? String(v);
  // last 只是後端查不到現價時的備用；方向以後端用跟背景檢查同一個來源查到的現價決定（美股盤後時兩者會不同）
  const addAlert = (price: number, note: string) =>
    createAlert(sym.market, sym.symbol, price, lastClose(), note).then(() => { loadAlerts(); });
  const removeAlert = (a: Alert) => {
    if (!window.confirm(`刪除 ${fmtPrice(a.price)} 的提醒？`)) return;
    deleteAlert(a.id).then(loadAlerts, (e: Error) => setAlertErr(e.message));
  };
  const onPlus = (e: React.MouseEvent) => {
    const price = plus.current.price;
    if (mobile) { setPlusSheet(price); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items: [
      { label: `在 ${fmtPrice(price)} 增加關於 ${sym.symbol} 的提醒`, icon: "alarmPlus", act: () => setAlertNew(price) },
      { label: `在 ${fmtPrice(price)} 繪製水平線`, icon: "hline", act: () => ctrlRef.current?.addHline(price) },
    ] });
  };
  useEffect(() => {
    const ln = settings.chartType === "line", t = "rgba(0,0,0,0)";
    candleRef.current?.applyOptions(ln
      ? { upColor: t, downColor: t, wickUpColor: t, wickDownColor: t }
      : { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
    lineRef.current?.applyOptions({ visible: ln });
  }, [settings.chartType]);
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: settings.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [settings.log]);
  useEffect(() => {
    if (!auto.current.fitting) chartRef.current?.priceScale("right").applyOptions({ autoScale: settings.autoScale });
  }, [settings.autoScale]);
  useEffect(() => { ctrlRef.current?.setTool(tool); }, [tool]);
  useEffect(() => { layerRef.current?.setIv(iv); }, [iv]);
  useEffect(() => { ctrlRef.current?.setMagnet(settings.magnet); }, [settings.magnet]);

  const pickSpan = (s: (typeof SPANS)[number]) => {
    const want = sym.market === "crypto" ? s.crypto : s.stock;
    if (want === iv) showSpan(s.sec);
    else { ctx.current.span = s.sec; onIv(want); }
  };
  const pickRef = useRef(pickSpan);
  pickRef.current = pickSpan;
  // 重設圖表視圖（Alt+R）：回到最新、預設根數、價格軸自動對一次
  const resetView = () => {
    const chart = chartRef.current, n = barsRef.current.length;
    if (!chart || !n) return;
    chart.timeScale().setVisibleLogicalRange({ from: n - (mobile ? 70 : 150), to: n + 6 });
    auto.current.fitting = true;
    chart.priceScale("right").applyOptions({ autoScale: true });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chart.priceScale("right").applyOptions({ autoScale: auto.current.on });
      auto.current.fitting = false;
    }));
  };
  const resetRef = useRef(resetView);
  resetRef.current = resetView;

  // 電腦版右鍵：點在圖形上 = 圖形選單；點空白 = 圖表選單
  const onMenu = (e: React.MouseEvent) => {
    if (mobile) return;
    e.preventDefault();
    const ctrlX = ctrlRef.current, el = box.current, cs = candleRef.current;
    if (!ctrlX || !el || !cs) return;
    const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const d = ctrlX.pickAt(x, y);
    const price = cs.coordinateToPrice(y);
    const fp = (v: number) => cs.priceFormatter().format(v);
    const items: MenuItem[] = d ? [
      { label: "設定…", icon: "gear", act: () => setCfg(true) },
      { label: "複製一份", icon: "copy", act: () => ctrlX.duplicateSelected() },
      { label: d.locked ? "解除鎖定" : "鎖定", icon: "lock", act: () => ctrlX.patchSelected({ locked: !d.locked }) },
      "sep",
      { label: "移到最上層", act: () => ctrlX.orderSelected(true) },
      { label: "移到最下層", act: () => ctrlX.orderSelected(false) },
      "sep",
      { label: "刪除", icon: "trash", hint: "Del", danger: true, act: () => ctrlX.removeSelected() },
    ] : [
      ...(price != null && y < (layerRef.current?.size.h ?? 0) ? [
        { label: `在 ${fp(price)} 新增價格提醒`, icon: "alarmPlus", act: () => setAlertNew(price) },
        { label: `在 ${fp(price)} 畫水平線`, icon: "hline", act: () => ctrlX.addHline(price) },
        { label: `複製價格 ${fp(price)}`, icon: "copy", act: () => { navigator.clipboard?.writeText(fp(price).replace(/,/g, "")).catch(() => {}); } },
        "sep" as const,
      ] : []),
      { label: `價格提醒（${alerts.length}）…`, icon: "alarm", act: () => setAlertList(true) },
      "sep",
      { label: "重設圖表視圖", icon: "end", hint: "Alt+R", act: resetView },
      { label: "回到最新", act: () => chartRef.current?.timeScale().scrollToRealTime() },
      "sep",
      { label: "K 線", check: settings.chartType === "candle", act: () => onPatch({ chartType: "candle" }) },
      { label: "折線", check: settings.chartType === "line", act: () => onPatch({ chartType: "line" }) },
      "sep",
      { label: "磁鐵（吸附開高低收）", check: settings.magnet, act: () => onPatch({ magnet: !settings.magnet }) },
      { label: "對數座標", check: settings.log, act: () => onPatch({ log: !settings.log }) },
      { label: draw?.hidden ? "顯示所有圖形" : "隱藏所有圖形", icon: draw?.hidden ? "eye" : "eyeOff", act: () => ctrlX.toggleHidden() },
      { label: `刪除所有圖形（${draw?.count ?? 0}）`, icon: "trash", danger: true, disabled: !draw?.count,
        act: () => { if (window.confirm(`刪除 ${sym.symbol} 的所有圖形？（可以用復原救回）`)) ctrlX.clearAll(); } },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  useImperativeHandle(ref, () => ({
    undo: () => ctrlRef.current?.undo(), redo: () => ctrlRef.current?.redo(),
    clearAll: () => ctrlRef.current?.clearAll(), toggleHidden: () => ctrlRef.current?.toggleHidden(),
    pickSpan: (label) => { const s = SPANS.find((x) => x.label === label); if (s) pickRef.current(s); },
    autoScale: () => auto.current.patch({ autoScale: true }),
    resetView: () => resetRef.current(),
    openAlerts: () => setAlertList(true),
    scrollBars: (n) => {
      const ts = chartRef.current?.timeScale(), r = ts?.getVisibleLogicalRange();
      if (ts && r) ts.setVisibleLogicalRange({ from: r.from + n, to: r.to + n });
    },
    zoom: (k) => {   // 以右緣為錨縮放：k < 1 放大、k > 1 縮小
      const ts = chartRef.current?.timeScale(), r = ts?.getVisibleLogicalRange();
      if (ts && r) ts.setVisibleLogicalRange({ from: r.to - Math.max(10, (r.to - r.from) * k), to: r.to });
    },
  }), []);

  // ── 圖例：游標所在那根（沒有游標時是最新一根）──
  const b = barsRef.current;
  const i = hover != null && hover < b.length ? hover : b.length - 1;
  const cur = b[i], prev = b[i - 1];
  const chg = cur && prev ? cur.c - prev.c : 0, pct = cur && prev && prev.c ? (chg / prev.c) * 100 : 0;
  const tone = cur && cur.c >= (prev?.c ?? cur.o) ? "up" : "down";
  const f = (v: number) => {
    if (!cur) return "";
    const p = precision(b[b.length - 1].c);
    return mobile ? v.toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p }) : v.toFixed(p);
  };
  const sel = draw?.selected ?? null;
  const ctrl = ctrlRef.current;

  return (
    <section className={`chart-wrap${mobile ? " is-mobile" : ""}`} aria-label={`${sym.symbol} ${IV_LABEL[iv]} K 線圖`} onContextMenu={onMenu}>
      <div className="chart-box" ref={box} />
      <div className="last-tag" ref={lastRef} style={{ display: "none" }} />
      <button className="xh-plus" ref={plusRef} style={{ display: "none" }} aria-label="在這個價格新增提醒或水平線"
        onPointerEnter={() => { plus.current.over = true; clearTimeout(plus.current.timer); }}
        onPointerLeave={(e) => { plus.current.over = false; if (e.pointerType === "mouse") e.currentTarget.style.display = "none"; }}
        onPointerDown={(e) => e.stopPropagation()} onClick={onPlus}><Icon name="plusCircle" size={20} /></button>
      <button ref={aBtn} className={`axis-a${settings.autoScale ? " on" : ""}`} aria-pressed={settings.autoScale}
        aria-label="自動調整價格軸高度" title="自動調整價格軸高度" onClick={() => onPatch({ autoScale: !settings.autoScale })}>A</button>

      {mobile && (
        <div className="mlegend">
          <div className="ml-title">
            <SymIcon sym={sym} size={19} />
            <b>{sym.market === "tw" ? `${sym.symbol} ${sym.name}` : sym.name || sym.symbol}</b>
          </div>
          {cur && (
            <div className={`ml-price ${tone}`}>
              {f(cur.c)} {chg >= 0 ? "+" : "−"}{f(Math.abs(chg))} ({chg >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)
            </div>
          )}
          {cur && hover != null && (
            <div className="ml-ohlc"><i>開</i>{f(cur.o)} <i>高</i>{f(cur.h)} <i>低</i>{f(cur.l)} <i>收</i>{f(cur.c)}</div>
          )}
          {!fold && cur && (
            <>
              {settings.vol && <div className="ml-ind">成交量 <span className={tone}>{fmtVol(cur.v)}</span></div>}
              {GROUPS.filter((g) => settings[g.key].on).map((g) => (
                <div className="ml-ind" key={g.key}>
                  {g.name(settings)}
                  {indRef.current.filter((x) => !x.hist && g.match(x.label)).map((x) => (
                    <span key={x.label} style={{ color: x.color }}>
                      {x.values[i] != null ? (x.values[i] as number).toFixed(g.key === "rsi" ? 2 : precision(cur.c)) : "—"}
                    </span>
                  ))}
                  <button aria-label={`隱藏 ${g.key}`} onClick={() => onPatch({ [g.key]: { ...settings[g.key], on: false } })}>
                    <Icon name="eyeOff" size={18} />
                  </button>
                </div>
              ))}
            </>
          )}
          {(settings.vol || GROUPS.some((g) => settings[g.key].on)) && (
            <button className={`ml-fold${fold ? " on" : ""}`} aria-label={fold ? "展開圖例" : "收合圖例"} onClick={() => setFold(!fold)}>
              <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
      )}

      {!mobile && <div className="legend">
        <div className="legend-row">
          <SymIcon sym={sym} size={18} />
          <span className="legend-title">{sym.market === "tw" ? `${sym.symbol} ${sym.name}` : sym.name || sym.symbol} · {IV_SHORT[iv]} · {sym.exch || MARKET_LABEL[sym.market]}</span>
          {cur && (settings.chartType === "line" ? (
            <span className={`legend-ohlc ${tone}`}>
              <b>{f(cur.c)}</b> <span>{chg >= 0 ? "+" : "−"}{f(Math.abs(chg))} ({chg >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>
            </span>
          ) : (
            <span className="legend-ohlc">
              <i>開</i><b className={tone}>{f(cur.o)}</b> <i>高</i><b className={tone}>{f(cur.h)}</b> <i>低</i><b className={tone}>{f(cur.l)}</b>{" "}
              <i>收</i><b className={tone}>{f(cur.c)}</b>{" "}
              <span className={tone}>{chg >= 0 ? "+" : "−"}{f(Math.abs(chg))} ({chg >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>
            </span>
          ))}
          {cur && settings.vol && <span className="legend-vol"><i>成交量</i><b className={tone}>{fmtVol(cur.v)}</b></span>}
        </div>
        {cur && GROUPS.filter((g) => settings[g.key].on).map((g) => (
          <div className="legend-ind" key={g.key}>
            <span>{g.name(settings)}</span>
            {indRef.current.filter((x) => !x.hist && g.match(x.label)).map((x) => (
              <b key={x.label} style={{ color: x.color }}>
                {x.values[i] != null ? (x.values[i] as number).toFixed(g.key === "rsi" ? 2 : precision(cur.c)) : "—"}
              </b>
            ))}
            <button aria-label={`隱藏 ${g.name(settings)}`} title="隱藏" onClick={() => onPatch({ [g.key]: { ...settings[g.key], on: false } })}>
              <Icon name="eyeOff" size={16} />
            </button>
          </div>
        ))}
      </div>}

      {cfg && sel && ctrl && (
        <DrawingSettings d={sel} ctrl={ctrl} onClose={() => setCfg(false)} tpls={settings.drawTpl?.[sel.kind] ?? []}
          onTpls={(list) => onPatch({ drawTpl: { ...settings.drawTpl, [sel.kind]: list } })} />
      )}

      {sel && ctrl && !edit && mobile && !cfg && (
        <div className="props mini" role="toolbar" aria-label="圖形操作">
          <span className="mini-tip">連點兩下開設定</span>
          <button className="pbtn" aria-label="設定" onClick={() => setCfg(true)}><Icon name="gear" /></button>
          <button className={`pbtn${sel.locked ? " on" : ""}`} aria-label="鎖定" onClick={() => ctrl.patchSelected({ locked: !sel.locked })}><Icon name="lock" /></button>
          <button className="pbtn danger" aria-label="刪除" onClick={() => ctrl.removeSelected()}><Icon name="trash" /></button>
        </div>
      )}

      {sel && ctrl && !edit && !mobile && !cfg && (
        <DrawBar color={sel.color} width={sel.width} dash={sel.dash} locked={!!sel.locked} text={sel.kind === "text"}
          pos={settings.propsPos} onPos={(p) => onPatch({ propsPos: p })} onPatch={(p) => ctrl.patchSelected(p)}
          onSettings={() => setCfg(true)} onCopy={() => ctrl.duplicateSelected()} onDelete={() => ctrl.removeSelected()}
          onText={() => { const a = ctrl.anchor(sel); if (a) setEdit({ id: sel.id, x: a.x, y: a.y, value: sel.text ?? "" }); }} />
      )}
      {menu && <CtxMenu {...menu} onClose={() => setMenu(null)} />}
      {plusSheet != null && (
        <PlusSheet label={fmtPrice(plusSheet)} symbol={sym.symbol} onClose={() => setPlusSheet(null)}
          onAlert={() => setAlertNew(plusSheet)} onHline={() => ctrlRef.current?.addHline(plusSheet)} />
      )}
      {alertNew != null && (
        <AlertCreate symbol={sym.symbol} price={alertNew} last={lastClose()} fmt={fmtPrice}
          onSave={addAlert} onClose={() => setAlertNew(null)} />
      )}
      {alertList && alertNew == null && (
        <AlertList symbol={sym.symbol} items={alerts} fmt={fmtPrice} err={alertErr} onClose={() => setAlertList(false)}
          onAdd={() => setAlertNew(lastClose())} onDelete={removeAlert} />
      )}

      {edit && (
        <input className="text-edit" autoFocus value={edit.value} placeholder="輸入文字後按 Enter"
          style={{ left: Math.max(4, edit.x), top: Math.max(4, edit.y - 26) }}
          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { ctrlRef.current?.setText(edit.id, edit.value.trim()); setEdit(null); }
            if (e.key === "Escape") { ctrlRef.current?.setText(edit.id, ""); setEdit(null); }
          }}
          onBlur={() => { ctrlRef.current?.setText(edit.id, edit.value.trim()); setEdit(null); }} />
      )}

      {loading && <div className="chart-msg">載入中…</div>}
      {err && !loading && <div className="chart-msg err">{err}</div>}
      {!atEnd && !loading && (
        <button className="to-end" aria-label="回到最新" title="回到最新"
          onClick={() => chartRef.current?.timeScale().scrollToRealTime()}><Icon name="end" /></button>
      )}

      {!mobile && <footer className="chart-foot">
        <div className="spans">
          {SPANS.map((s) => <button key={s.label} onClick={() => pickSpan(s)}>{s.label}</button>)}
        </div>
        <div className="foot-right">
          {saved && <span className={`save${saved === "已儲存" || saved === "儲存中" ? "" : " err"}`}>{saved}</span>}
          <Clock />
          <button className={settings.log ? "on" : ""} aria-pressed={settings.log} onClick={() => onPatch({ log: !settings.log })}>對數</button>
          <button className={settings.autoScale ? "on" : ""} aria-pressed={settings.autoScale}
            onClick={() => onPatch({ autoScale: !settings.autoScale })}>自動</button>
        </div>
      </footer>}
    </section>
  );
});
