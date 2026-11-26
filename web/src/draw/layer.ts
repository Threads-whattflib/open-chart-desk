// 畫圖圖層：lightweight-charts 的 series primitive，自己把所有圖形畫在主圖 canvas 上，並負責座標換算與命中判斷。
// 時間存 UTC 秒，畫的時候用相鄰兩根 K 棒線性內插成 logical index，所以換週期、往左補歷史後圖形位置不變。
import type {
  IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView,
  Logical, SeriesAttachedParameter, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { ivGroup, type Bar, type Drawing, type Kind, type Pt } from "../types";

export const NEED: Record<Kind, number> = {
  trend: 2, ray: 2, ext: 2, hline: 1, hray: 1, vline: 1, rect: 2, channel: 3, fib: 2, text: 1, measure: 2,
  long: 1, short: 1, frvp: 2, prange: 2, drange: 2, arrowup: 1, arrowdown: 1, plabel: 1, fibext: 3,
};
// Fib 延伸（趨勢型，三點）：層級 = 第三點 + (第二點 − 第一點) × r；預設只畫常用的 5 層，其他可勾
export const FIBX_ALL = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236];
export const FIBX_DEFAULT = [0, 0.618, 1, 1.618, 2.618];
export const FIBX_OPTS = { trend: true, bg: true, price: false };
export const fibxPrice = (d: Drawing, r: number) => d.pts[2].p + (d.pts[1].p - d.pts[0].p) * r;
const ARROW_H = 26, ARROW_W = 18;   // 向上 / 向下箭頭的大小（像素，不隨縮放變）
// Fib 預設：只畫 0.618 與 0.66、不畫趨勢線、有背景、標籤只顯示數值（其他層級在設定頁勾選）
export const FIB_ALL = [0, 0.236, 0.382, 0.5, 0.618, 0.66, 0.705, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
export const FIB_DEFAULT = [0.618, 0.66];
export const FIB_OPTS = { trend: false, bg: true, price: false };
// FRVP 預設：200 行、數值區 70%、向右延伸、寬度 30%、VAH / VAL / POC 都畫
export const FRVP_OPTS = { rows: 200, va: 70, extend: true, width: 30, vah: true, val: true, poc: true };
const FIB_COLOR: Record<string, string> = {
  "0": "#8a909c", "0.236": "#8a909c", "0.382": "#b5a62e", "0.5": "#4fc27c", "0.618": "#5aa7b8", "0.66": "#5aa7b8",
  "0.705": "#a8a27c", "0.786": "#4f8dff", "1": "#8a909c", "1.272": "#5aa7b8", "1.414": "#e5484d", "1.618": "#b5a62e",
  "2": "#4fc27c", "2.618": "#c77dff", "3.618": "#e5484d", "4.236": "#c77dff",
};
export const UP = "#16c784", DOWN = "#ff4d4d", ACCENT = "#2f6bff";
const HANDLE_R = 5;
export const HIT_TOL = 6, HIT_TOL_TOUCH = 14;
const FONT = '500 11px "JetBrains Mono", ui-monospace, Menlo, monospace';
const SANS = '"PingFang TC", "Noto Sans TC", system-ui, sans-serif';
/** 可以在線上加文字的工具（設定頁「文字」分頁）。 */
export const LINE_TEXT: ReadonlySet<Kind> = new Set<Kind>(["trend", "ray", "ext", "hline", "hray", "vline", "rect", "channel"]);
/** #rrggbb + 不透明度 → rgba()；其他格式照原樣。 */
export function withAlpha(c: string, a = 1): string {
  if (a >= 1 || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  const n = parseInt(c.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, a)})`;
}

export type XY = { x: number; y: number };
export type Hit = { id: string; part: "body" | number };
export type CursorPt = Pt & XY;

export const fibPrice = (d: Drawing, r: number) => d.pts[1].p - (d.pts[1].p - d.pts[0].p) * r;   // 0 在第二點、1 在第一點
export const newId = () => Math.random().toString(36).slice(2, 10);

/** 拖某個把手後的新圖形（不改原物件）。 */
export function applyHandle(d: Drawing, idx: number, pt: Pt): Drawing {
  const pts = d.pts.map((p) => ({ ...p }));
  switch (d.kind) {
    case "hline": pts[0].p = pt.p; break;
    case "vline": pts[0].t = pt.t; break;
    case "rect": case "measure":
      if (idx === 2) { pts[0].t = pt.t; pts[1].p = pt.p; }
      else if (idx === 3) { pts[1].t = pt.t; pts[0].p = pt.p; }
      else pts[idx] = pt;
      break;
    case "long": case "short": {
      const up = d.kind === "long" ? 1 : -1;
      if (idx === 0) pts[0] = pt;
      else if (idx === 1) pts[1].p = pt.p;
      else if (idx === 2) pts[2].p = pt.p;
      else if (pt.t > pts[0].t) pts[1].t = pts[2].t = pt.t;
      // 停利一定在進場的獲利方向、停損在反方向
      if ((pts[1].p - pts[0].p) * up < 0) pts[1].p = pts[0].p;
      if ((pts[0].p - pts[2].p) * up < 0) pts[2].p = pts[0].p;
      break;
    }
    default: pts[idx] = pt;
  }
  return { ...d, pts };
}

export class DrawLayer implements ISeriesPrimitive<Time> {
  private p: SeriesAttachedParameter<Time> | null = null;
  private bars: Bar[] = [];
  private items: Drawing[] = [];
  private selected: string | null = null;
  private draft: Drawing | null = null;
  private marker: Pt | null = null;
  private aim: XY | null = null;       // 手機畫圖時的瞄準十字
  private hidden = false;
  private iv = "";
  private axis: ISeriesPrimitiveAxisView[] = [];
  private textBox = new Map<string, { w: number; h: number }>();
  private vpCache = new Map<string, { key: string; vp: Profile | null }>();
  size = { w: 0, h: 0 };

  attached(p: SeriesAttachedParameter<Time>) { this.p = p; }
  detached() { this.p = null; }
  updateAllViews() {}

  setBars(bars: Bar[]) { this.bars = bars; this.p?.requestUpdate(); }
  /** 目前週期：設定頁「可見性」關掉這一組的圖形不畫、也點不到。 */
  setIv(iv: string) { this.iv = iv; this.rebuildAxis(); this.p?.requestUpdate(); }
  shown(d: Drawing) { return !d.hideOn?.length || !d.hideOn.includes(ivGroup(this.iv)); }
  set(items: Drawing[], selected: string | null, draft: Drawing | null, marker: Pt | null, hidden: boolean, aim: XY | null = null) {
    this.items = items; this.selected = selected; this.draft = draft; this.marker = marker; this.hidden = hidden; this.aim = aim;
    this.rebuildAxis();
    this.p?.requestUpdate();
  }

  // ── 時間 ↔ logical index ──
  tToL(t: number): number {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (n === 1) return (t - b[0].t) / 86400;
    let lo = 0, hi = n - 1, i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (i < 0) return (t - b[0].t) / (b[1].t - b[0].t);
    if (i >= n - 1) return n - 1 + (t - b[n - 1].t) / (b[n - 1].t - b[n - 2].t);
    return i + (t - b[i].t) / (b[i + 1].t - b[i].t);
  }
  lToT(l: number): number {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (n === 1) return Math.round(b[0].t + l * 86400);
    const i = Math.floor(l), f = l - i;
    if (i < 0) return Math.round(b[0].t + l * (b[1].t - b[0].t));
    if (i >= n - 1) return Math.round(b[n - 1].t + (l - (n - 1)) * (b[n - 1].t - b[n - 2].t));
    return Math.round(b[i].t + f * (b[i + 1].t - b[i].t));
  }

  // ── 像素座標 ──（logicalToCoordinate 遇到非整數會回 0，整數交給它、小數用 barSpacing 補）
  xOf(t: number): number | null {
    const ts = this.p?.chart.timeScale();
    if (!ts) return null;
    const l = this.tToL(t), i = Math.floor(l);
    const x = ts.logicalToCoordinate(i as Logical);
    return x == null ? null : x + (l - i) * ts.options().barSpacing;
  }
  yOf(price: number): number | null { return this.p?.series.priceToCoordinate(price) ?? null; }
  fmt(price: number): string { return this.p?.series.priceFormatter().format(price) ?? ""; }
  fromPx(x: number, y: number): Pt | null {
    const p = this.p?.series.coordinateToPrice(y), l = this.p?.chart.timeScale().coordinateToLogical(x);
    return p == null || l == null ? null : { t: this.lToT(l), p };
  }

  /** 游標 → 時間／價位；snap = 吸到最近那根 K 棒的開高低收（磁鐵 / 按住 Ctrl）。 */
  point(x: number, y: number, snap: boolean): CursorPt | null {
    if (snap && this.bars.length) {
      const l = this.p?.chart.timeScale().coordinateToLogical(x);
      if (l == null) return null;
      const b = this.bars[Math.max(0, Math.min(this.bars.length - 1, Math.round(l)))];
      let best: CursorPt | null = null;
      for (const v of [b.o, b.h, b.l, b.c]) {
        const yy = this.yOf(v);
        if (yy != null && (!best || Math.abs(yy - y) < Math.abs(best.y - y))) {
          best = { t: b.t, p: v, x: this.xOf(b.t) ?? x, y: yy };
        }
      }
      return best;
    }
    const pt = this.fromPx(x, y);
    return pt ? { ...pt, x, y } : null;
  }

  private px(d: Drawing): XY[] | null {
    const out: XY[] = [];
    for (const p of d.pts) {
      const x = this.xOf(p.t), y = this.yOf(p.p);
      if (x == null || y == null) return null;
      out.push({ x, y });
    }
    return out;
  }

  handles(d: Drawing, q: XY[]): XY[] {
    const { w, h } = this.size;
    switch (d.kind) {
      case "hline": return [{ x: w / 2, y: q[0].y }];
      case "vline": return [{ x: q[0].x, y: h / 2 }];
      case "rect": case "measure": return [q[0], q[1], { x: q[0].x, y: q[1].y }, { x: q[1].x, y: q[0].y }];
      case "long": case "short":
        return [q[0], { x: q[0].x, y: q[1].y }, { x: q[0].x, y: q[2].y }, { x: q[1].x, y: q[0].y }];
      default: return q;
    }
  }

  /** 點到哪個圖形：先看選中那個的把手，再由上層往下找線身。 */
  hit(x: number, y: number, tol = HIT_TOL): Hit | null {
    if (this.hidden) return null;
    const sel = this.items.find((d) => d.id === this.selected);
    if (sel && !sel.locked && this.shown(sel)) {
      const q = this.px(sel);
      if (q) {
        const hs = this.handles(sel, q);
        for (let i = 0; i < hs.length; i++) {
          if (Math.hypot(x - hs[i].x, y - hs[i].y) <= tol + HANDLE_R) return { id: sel.id, part: i };
        }
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i], q = this.shown(d) ? this.px(d) : null;
      if (q && this.bodyDist(d, q, x, y) <= tol) return { id: d.id, part: "body" };
    }
    return null;
  }

  private bodyDist(d: Drawing, q: XY[], x: number, y: number): number {
    const [a, b] = q;
    switch (d.kind) {
      case "trend": return segDist(x, y, a, b);
      case "ray": { const [s, e] = extend(a, b, false); return segDist(x, y, s, e); }
      case "ext": { const [s, e] = extend(a, b, true); return segDist(x, y, s, e); }
      case "hline": return Math.abs(y - a.y);
      case "hray": return x >= a.x - 4 ? Math.abs(y - a.y) : Infinity;
      case "vline": return Math.abs(x - a.x);
      case "rect": case "measure": return boxDist(x, y, a.x, a.y, b.x, b.y);
      case "prange": return boxDist(x, y, Math.min(a.x, b.x) - 4, a.y, Math.max(a.x, b.x) + 4, b.y);
      case "frvp": {
        const vp = this.profile(d), yt = vp ? this.yOf(vp.hi) : null, yb = vp ? this.yOf(vp.lo) : null;
        return yt == null || yb == null ? boxDist(x, y, a.x, a.y, b.x, b.y) : boxDist(x, y, a.x, yt, b.x, yb);
      }
      case "long": case "short": return boxDist(x, y, a.x, Math.min(b.y, q[2].y), b.x, Math.max(b.y, q[2].y));
      case "channel": {
        const off = this.chanOffset(q);
        return Math.min(segDist(x, y, a, b), segDist(x, y, { x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }));
      }
      case "fib": {
        let dist = segDist(x, y, a, b);
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        for (const r of d.levels ?? FIB_DEFAULT) {
          const yy = this.yOf(fibPrice(d, r));
          if (yy != null) dist = Math.min(dist, segDist(x, y, { x: x0, y: yy }, { x: x1, y: yy }));
        }
        return dist;
      }
      case "text": {
        const tb = this.textBox.get(d.id) ?? { w: 40, h: 18 };
        return boxDist(x, y, a.x, a.y - tb.h, a.x + tb.w, a.y);
      }
      case "drange": return boxDist(x, y, a.x, Math.min(a.y, b.y) - 4, b.x, Math.max(a.y, b.y) + 4);
      case "arrowup": case "arrowdown": case "plabel": { const [x1, y1, x2, y2] = this.markBox(d, a); return boxDist(x, y, x1, y1, x2, y2); }
      case "fibext": {
        let dist = Math.min(segDist(x, y, a, b), q[2] ? segDist(x, y, b, q[2]) : Infinity);
        if (!q[2]) return dist;
        const [x0, x1] = this.fibxSpan(q);
        for (const r of d.levels ?? FIBX_DEFAULT) {
          const yy = this.yOf(fibxPrice(d, r));
          if (yy != null) dist = Math.min(dist, segDist(x, y, { x: x0, y: yy }, { x: x1, y: yy }));
        }
        return dist;
      }
    }
  }

  // 箭頭 / 價格標籤占的框（像素，固定大小）：向上箭頭尖端在點上、身體往下；向下相反；價格標籤在點的正上方
  private markBox(d: Drawing, a: XY): [number, number, number, number] {
    if (d.kind === "arrowup") return [a.x - ARROW_W / 2, a.y, a.x + ARROW_W / 2, a.y + ARROW_H];
    if (d.kind === "arrowdown") return [a.x - ARROW_W / 2, a.y - ARROW_H, a.x + ARROW_W / 2, a.y];
    const tb = this.textBox.get(d.id) ?? { w: 70, h: 22 };
    return [a.x - tb.w / 2, a.y - 7 - tb.h, a.x + tb.w / 2, a.y];
  }
  // Fib 延伸的層級線左右範圍：從第三點往右，長度 = 第一、二點的水平距離（至少 60px）
  private fibxSpan(q: XY[]): [number, number] {
    const c = q[2];
    return [c.x, c.x + Math.max(60, Math.abs(q[1].x - q[0].x))];
  }

  // 平行通道第二條線相對第一條線的垂直位移（像素），由第三點決定
  private chanOffset(q: XY[]): number {
    const [a, b, c] = q;
    if (!c) return 0;
    const k = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x);
    return c.y - (a.y + k * (c.x - a.x));
  }

  // ── 價格軸標籤：水平線、水平射線、部位工具的三個價位 ──
  private rebuildAxis() {
    const self = this;
    const mk = (price: number, back: string): ISeriesPrimitiveAxisView => ({
      coordinate: () => self.yOf(price) ?? -1e4,
      text: () => self.fmt(price),
      textColor: () => "#fff",
      backColor: () => back,
      visible: () => !self.hidden && self.yOf(price) != null,
      tickVisible: () => true,
    });
    const out: ISeriesPrimitiveAxisView[] = [];
    for (const d of this.draft ? [...this.items, this.draft] : this.items) {
      if (!d.pts.length || !this.shown(d)) continue;
      if ((d.kind === "hline" || d.kind === "hray") && d.opts?.plab !== false) out.push(mk(d.pts[0].p, d.color));
      else if ((d.kind === "long" || d.kind === "short") && d.pts.length === 3 && (d.id === this.selected || d.id === "draft")) {
        out.push(mk(d.pts[0].p, "#5b6170"), mk(d.pts[1].p, UP), mk(d.pts[2].p, DOWN));   // 倉位的三個價位：選中才標
      }
    }
    this.axis = out;
  }
  priceAxisViews() { return this.axis; }

  paneViews(): IPrimitivePaneView[] {
    const self = this;
    const renderer: IPrimitivePaneRenderer = {
      draw(target: CanvasRenderingTarget2D) {
        if (!self.p) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          self.size = { w: mediaSize.width, h: mediaSize.height };
          if (self.hidden) return;
          ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.font = FONT;
          for (const d of self.items) if (self.shown(d)) self.drawOne(ctx, d, d.id === self.selected);
          if (self.draft) self.drawOne(ctx, self.draft, true);
          if (self.aim) {   // 瞄準十字：虛線，位置由拖曳決定，點一下才放點
            ctx.save();
            ctx.strokeStyle = "#e5e5ea"; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
            ctx.beginPath(); ctx.moveTo(0, self.aim.y); ctx.lineTo(mediaSize.width, self.aim.y);
            ctx.moveTo(self.aim.x, 0); ctx.lineTo(self.aim.x, mediaSize.height); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = "#0b0b0c"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(self.aim.x, self.aim.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            const price = self.p!.series.coordinateToPrice(self.aim.y);
            if (price != null) label(ctx, [self.fmt(price)], mediaSize.width - 40, self.aim.y, "center", "#3a3f4b", mediaSize.width);
            ctx.restore();
          }
          if (self.marker) {
            const x = self.xOf(self.marker.t), y = self.yOf(self.marker.p);
            if (x != null && y != null) {
              ctx.save();
              ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2; ctx.setLineDash([]);
              ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
              ctx.restore();
            }
          }
        });
      },
    };
    return [{ zOrder: () => "top", renderer: () => renderer }];
  }

  private drawOne(ctx: CanvasRenderingContext2D, d: Drawing, on: boolean) {
    const q = this.px(d);
    if (!q || !q.length) return;
    const { w: W, h: H } = this.size;
    const [a, b] = q;
    ctx.save();
    const col = withAlpha(d.color, d.opacity ?? 1);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = d.width;
    ctx.setLineDash(d.dash === 1 ? [6, 5] : d.dash === 2 ? [1.5, 4] : []);
    const line = (s: XY, e: XY) => { ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke(); };
    const fill = (alpha: number, fn: () => void) => { ctx.save(); ctx.globalAlpha = alpha; fn(); ctx.restore(); };

    switch (d.kind) {
      case "hline": line({ x: 0, y: a.y }, { x: W, y: a.y }); break;
      case "hray": line(a, { x: W, y: a.y }); break;
      case "vline": line({ x: a.x, y: 0 }, { x: a.x, y: H }); break;
      case "trend": if (b) line(a, b); break;
      case "ray": if (b) { const [s, e] = extend(a, b, false); line(s, e); } break;
      case "ext": if (b) { const [s, e] = extend(a, b, true); line(s, e); } break;
      case "rect":
        if (!b) break;
        fill(0.14, () => ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y));
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        break;
      case "channel": {
        if (!b) break;
        line(a, b);
        if (!q[2]) break;
        const off = this.chanOffset(q);
        const a2 = { x: a.x, y: a.y + off }, b2 = { x: b.x, y: b.y + off };
        line(a2, b2);
        fill(0.1, () => {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y);
          ctx.closePath(); ctx.fill();
        });
        ctx.save();
        ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        line({ x: a.x, y: a.y + off / 2 }, { x: b.x, y: b.y + off / 2 });
        ctx.restore();
        break;
      }
      case "fib": if (b) this.drawFib(ctx, d, a, b); break;
      case "text": {
        const txt = d.text || "文字";
        ctx.font = '500 14px "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
        const tw = ctx.measureText(txt).width;
        this.textBox.set(d.id, { w: tw + 8, h: 22 });
        ctx.textBaseline = "bottom"; ctx.textAlign = "left";
        if (!d.text) ctx.globalAlpha = 0.45;
        ctx.fillText(txt, a.x + 4, a.y - 3);
        ctx.globalAlpha = 1;
        if (on) { ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.strokeRect(a.x, a.y - 22, tw + 8, 22); }
        ctx.font = FONT;
        break;
      }
      case "measure": if (b) this.drawMeasure(ctx, d, a, b); break;
      case "prange": if (b) this.drawPriceRange(ctx, d, a, b); break;
      case "frvp": if (b) this.drawFrvp(ctx, d, a, b); break;
      case "long": case "short": if (q.length === 3) this.drawPosition(ctx, d, q, on); break;
      case "drange": if (b) this.drawDateRange(ctx, d, a, b); break;
      case "fibext":
        if (!b) break;
        if (q[2]) this.drawFibExt(ctx, d, q);
        else { ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6; ctx.lineWidth = 1; line(a, b); }
        break;
      case "arrowup": case "arrowdown": {
        const s = d.kind === "arrowup" ? 1 : -1, hw = ARROW_W / 2, head = 11, sw = 3.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + hw, a.y + s * head); ctx.lineTo(a.x + sw, a.y + s * head);
        ctx.lineTo(a.x + sw, a.y + s * ARROW_H); ctx.lineTo(a.x - sw, a.y + s * ARROW_H);
        ctx.lineTo(a.x - sw, a.y + s * head); ctx.lineTo(a.x - hw, a.y + s * head);
        ctx.closePath(); ctx.fill();
        if (on) { ctx.lineWidth = 1; ctx.strokeStyle = "#fff"; ctx.stroke(); }
        break;
      }
      case "plabel": {
        const txt = this.fmt(d.pts[0].p);
        ctx.font = '600 12px "JetBrains Mono", ui-monospace, Menlo, monospace';
        const w = ctx.measureText(txt).width + 14, h = 22, top = a.y - 7 - h;
        this.textBox.set(d.id, { w, h });
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.roundRect(a.x - w / 2, top, w, h, 4); ctx.fill();
        ctx.beginPath(); ctx.moveTo(a.x - 6, a.y - 7.5); ctx.lineTo(a.x + 6, a.y - 7.5); ctx.lineTo(a.x, a.y); ctx.closePath(); ctx.fill();
        if (on) { ctx.lineWidth = 1; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.roundRect(a.x - w / 2, top, w, h, 4); ctx.stroke(); }
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, a.x, top + h / 2 + 0.5);
        ctx.font = FONT;
        break;
      }
    }
    if (d.text && LINE_TEXT.has(d.kind)) this.lineText(ctx, d, q);
    ctx.restore();

    if (on && !d.locked) {
      for (const h of this.handles(d, q)) {
        ctx.save();
        ctx.fillStyle = "#0f1218"; ctx.strokeStyle = d.kind === "long" || d.kind === "short" ? ACCENT : d.color;
        ctx.lineWidth = 2; ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** 固定範圍成交量分佈：兩點之間的 K 棒，把每根的量平均攤到它高低價涵蓋的價格列，分上漲 / 下跌量。 */
  private profile(d: Drawing): Profile | null {
    if (d.pts.length < 2) return null;
    const o = { ...FRVP_OPTS, ...d.opts }, t1 = Math.min(d.pts[0].t, d.pts[1].t), t2 = Math.max(d.pts[0].t, d.pts[1].t);
    const bs = this.bars, last = bs[bs.length - 1];
    const key = `${t1}|${t2}|${o.rows}|${o.va}|${bs.length}|${last ? last.c + last.v : 0}`;
    const hit = this.vpCache.get(d.id);
    if (hit && hit.key === key) return hit.vp;
    const rows = Math.max(10, Math.min(1000, Math.round(Number(o.rows))));
    let lo = Infinity, hi = -Infinity;
    const inside = bs.filter((x) => x.t >= t1 && x.t <= t2);
    for (const x of inside) { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); }
    let vp: Profile | null = null;
    if (inside.length && hi > lo) {
      const step = (hi - lo) / rows, up = new Float64Array(rows), dn = new Float64Array(rows);
      for (const x of inside) {
        const i0 = Math.max(0, Math.min(rows - 1, Math.floor((x.l - lo) / step)));
        const i1 = Math.max(0, Math.min(rows - 1, Math.floor((x.h - lo) / step)));
        const share = x.v / (i1 - i0 + 1), arr = x.c >= x.o ? up : dn;
        for (let k = i0; k <= i1; k++) arr[k] += share;
      }
      let poc = 0, max = 0, total = 0;
      for (let k = 0; k < rows; k++) { const v = up[k] + dn[k]; total += v; if (v > max) { max = v; poc = k; } }
      // 數值區：從 POC 往上下擴，每次併入量比較大的那一側，直到占總量 va%
      let a = poc, b = poc, acc = max;
      const want = total * Number(o.va) / 100;
      while (acc < want && (a > 0 || b < rows - 1)) {
        const below = a > 0 ? up[a - 1] + dn[a - 1] : -1, above = b < rows - 1 ? up[b + 1] + dn[b + 1] : -1;
        if (above >= below) { b++; acc += above; } else { a--; acc += below; }
      }
      vp = { lo, hi, step, up, dn, max, poc, vaLo: a, vaHi: b };
    }
    this.vpCache.set(d.id, { key, vp });
    if (this.vpCache.size > 60) this.vpCache.delete(this.vpCache.keys().next().value as string);
    return vp;
  }

  /** 線上的文字：位置 tal 0 左 / 1 中 / 2 右，tvp 0 線上方 / 1 線下方；字跟著線的角度轉，保持正向。 */
  private lineText(ctx: CanvasRenderingContext2D, d: Drawing, q: XY[]) {
    const { w: W, h: H } = this.size, [a, b] = q, o = d.opts ?? {};
    let s: XY, e: XY;
    switch (d.kind) {
      case "hline": s = { x: 0, y: a.y }; e = { x: W, y: a.y }; break;
      case "hray": s = a; e = { x: W, y: a.y }; break;
      case "vline": s = { x: a.x, y: H }; e = { x: a.x, y: 0 }; break;
      case "rect": { if (!b) return; const y = Math.min(a.y, b.y); s = { x: Math.min(a.x, b.x), y }; e = { x: Math.max(a.x, b.x), y }; break; }
      default: if (!b) return; s = a; e = b;
    }
    let ang = Math.atan2(e.y - s.y, e.x - s.x);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) { ang += Math.PI; [s, e] = [e, s]; }
    const al = Number(o.tal ?? 2), below = Number(o.tvp ?? 0) === 1, pad = 6;
    const k = al === 0 ? 0 : al === 1 ? 0.5 : 1;
    ctx.save();
    ctx.translate(s.x + (e.x - s.x) * k, s.y + (e.y - s.y) * k);
    ctx.rotate(ang);
    ctx.font = `500 ${Number(o.tsz ?? 13)}px ${SANS}`;
    ctx.fillStyle = withAlpha(d.textColor ?? d.color, d.opacity ?? 1);
    ctx.textAlign = al === 0 ? "left" : al === 1 ? "center" : "right";
    ctx.textBaseline = below ? "top" : "bottom";
    ctx.setLineDash([]);
    ctx.fillText(d.text ?? "", al === 0 ? pad : al === 2 ? -pad : 0, below ? 4 : -4);
    ctx.restore();
  }

  private drawFrvp(ctx: CanvasRenderingContext2D, d: Drawing, a: XY, b: XY) {
    const o = { ...FRVP_OPTS, ...d.opts }, vp = this.profile(d);
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), W = this.size.w;
    ctx.setLineDash([]);
    if (!vp) {   // 範圍內還沒有 K 棒（或正在拉第二點）：只畫範圍
      ctx.save(); ctx.globalAlpha = 0.5; ctx.strokeStyle = "#8a909c"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, this.size.h); ctx.moveTo(x1, 0); ctx.lineTo(x1, this.size.h); ctx.stroke(); ctx.restore();
      return;
    }
    const yTop = this.yOf(vp.hi), yBot = this.yOf(vp.lo);
    if (yTop == null || yBot == null) return;
    const rows = vp.up.length, rowH = (yBot - yTop) / rows, maxW = (x1 - x0) * Number(o.width) / 100;
    ctx.save(); ctx.globalAlpha = 0.07; ctx.fillStyle = "#8a909c"; ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop); ctx.restore();
    // 列高不到 1px 時把相鄰幾列併成一條畫，不然 200 列全疊在一起
    const group = Math.max(1, Math.ceil(1 / Math.max(rowH, 1e-6)));
    for (let k = 0; k < rows; k += group) {
      let u = 0, dnv = 0, va = false;
      for (let j = k; j < Math.min(rows, k + group); j++) { u = Math.max(u, vp.up[j]); dnv = Math.max(dnv, vp.dn[j]); va = va || (j >= vp.vaLo && j <= vp.vaHi); }
      const y = yBot - (k + group) * rowH, h = Math.max(1, rowH * group - (rowH * group > 3 ? 1 : 0));
      const wu = (u / vp.max) * maxW, wd = (dnv / vp.max) * maxW;
      ctx.fillStyle = va ? "#2e9e6bcc" : "#2e9e6b66"; ctx.fillRect(x0, y, wu, h);
      ctx.fillStyle = va ? "#c9485bcc" : "#c9485b66"; ctx.fillRect(x0 + wu, y, wd, h);
    }
    const hline = (row: number, color: string, dash: number[], edge: number) => {
      const y = yBot - (row + edge) * rowH;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(o.extend ? W : x1, y); ctx.stroke();
    };
    if (o.vah) hline(vp.vaHi, "#f23645", [5, 4], 1);
    if (o.val) hline(vp.vaLo, "#4caf50", [5, 4], 0);
    if (o.poc) hline(vp.poc, "#f23645", [], 0.5);
    ctx.setLineDash([]);
  }

  private drawFib(ctx: CanvasRenderingContext2D, d: Drawing, a: XY, b: XY) {
    const o = { ...FIB_OPTS, ...d.opts };
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const lv = [...(d.levels ?? FIB_DEFAULT)].sort((m, n) => m - n)
      .map((r) => ({ r, price: fibPrice(d, r), y: this.yOf(fibPrice(d, r)) }))
      .filter((v): v is { r: number; price: number; y: number } => v.y != null);
    if (o.trend) {
      ctx.save();
      ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
    this.drawLevels(ctx, d, lv, x0, x1, o);
  }

  /** Fib 延伸（趨勢型）：第一 → 第二點是那段波動，從第三點往上 / 下投射同樣幅度 × 各層級。 */
  private drawFibExt(ctx: CanvasRenderingContext2D, d: Drawing, q: XY[]) {
    const o = { ...FIBX_OPTS, ...d.opts }, [x0, x1] = this.fibxSpan(q);
    const lv = [...(d.levels ?? FIBX_DEFAULT)].sort((m, n) => m - n)
      .map((r) => ({ r, price: fibxPrice(d, r), y: this.yOf(fibxPrice(d, r)) }))
      .filter((v): v is { r: number; price: number; y: number } => v.y != null);
    if (o.trend) {
      ctx.save();
      ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.lineTo(q[2].x, q[2].y); ctx.stroke();
      ctx.restore();
    }
    this.drawLevels(ctx, d, lv, x0, x1, o);
  }

  // Fib 回撤 / 延伸共用：畫層級線、相鄰層之間的背景、右端標籤
  private drawLevels(ctx: CanvasRenderingContext2D, d: Drawing, lv: { r: number; price: number; y: number }[],
    x0: number, x1: number, o: Record<string, number | boolean>) {
    for (let i = 0; i < lv.length; i++) {
      const col = FIB_COLOR[String(lv[i].r)] ?? d.color;
      if (i > 0 && o.bg) {
        ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = col;
        ctx.fillRect(x0, lv[i - 1].y, x1 - x0, lv[i].y - lv[i - 1].y);
        ctx.restore();
      }
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x0, lv[i].y); ctx.lineTo(x1, lv[i].y); ctx.stroke();
      // 標籤在線的右端外側、垂直置中（TradingView 的「右 / 中間」）
      ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = '500 12px "JetBrains Mono", ui-monospace, Menlo, monospace';
      // 相鄰兩層靠太近（例如 0.618 與 0.66）時，標籤一個往上、一個往下錯開
      const near = (k: number) => lv[k] !== undefined && Math.abs(lv[k].y - lv[i].y) < 13;
      const dy = near(i + 1) ? (lv[i + 1].y > lv[i].y ? -6 : 6) : near(i - 1) ? (lv[i - 1].y > lv[i].y ? -6 : 6) : 0;
      const txt = o.price ? `${lv[i].r} (${this.fmt(lv[i].price)})` : String(lv[i].r);
      // 右邊放不下（線拉到價格軸旁）就改放在線的右端內側
      if (x1 + 5 + ctx.measureText(txt).width > this.size.w) { ctx.textAlign = "right"; ctx.fillText(txt, x1 - 4, lv[i].y + dy - 8); }
      else ctx.fillText(txt, x1 + 5, lv[i].y + dy);
    }
    ctx.font = FONT;
  }

  /** 日期範圍：兩條直線 + 中間水平箭頭，標「根數 · 時間長度」和範圍內成交量合計。 */
  private drawDateRange(ctx: CanvasRenderingContext2D, d: Drawing, a: XY, b: XY) {
    const [p1, p2] = d.pts;
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y, y0 + 24), my = (y0 + y1) / 2;
    ctx.setLineDash([]); ctx.strokeStyle = d.color; ctx.fillStyle = d.color; ctx.lineWidth = 1.5;
    ctx.save(); ctx.globalAlpha = 0.14; ctx.fillRect(Math.min(a.x, b.x), y0, Math.abs(b.x - a.x), y1 - y0); ctx.restore();
    ctx.beginPath(); ctx.moveTo(a.x, y0); ctx.lineTo(a.x, y1); ctx.moveTo(b.x, y0); ctx.lineTo(b.x, y1); ctx.stroke();
    arrow(ctx, { x: a.x, y: my }, { x: b.x, y: my });
    const t1 = Math.min(p1.t, p2.t), t2 = Math.max(p1.t, p2.t);
    let vol = 0;
    for (const x of this.bars) if (x.t >= t1 && x.t <= t2) vol += x.v;
    const nBars = Math.round(this.tToL(p2.t) - this.tToL(p1.t));
    label(ctx, [`${nBars} 根 · ${span(t2 - t1)}`, `量 ${compact(vol)}`], (a.x + b.x) / 2, y1 + 8, "below", "#2c2f38", this.size.w);
  }

  private drawMeasure(ctx: CanvasRenderingContext2D, d: Drawing, a: XY, b: XY) {
    const [p1, p2] = d.pts;
    const up = p2.p >= p1.p, col = up ? ACCENT : DOWN;
    ctx.setLineDash([]); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.save(); ctx.globalAlpha = 0.16; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    arrow(ctx, { x: mx, y: a.y }, { x: mx, y: b.y });
    arrow(ctx, { x: a.x, y: my }, { x: b.x, y: my });
    const diff = p2.p - p1.p, pct = p1.p ? (diff / p1.p) * 100 : 0;
    const nBars = Math.round(this.tToL(p2.t) - this.tToL(p1.t));
    const sign = diff >= 0 ? "+" : "-";
    const l1 = `${sign}${this.fmt(Math.abs(diff))} (${sign}${Math.abs(pct).toFixed(2)}%)`;
    const l2 = `${nBars} 根 · ${span(Math.abs(p2.t - p1.t))}`;
    label(ctx, [l1, l2], mx, up ? Math.min(a.y, b.y) - 8 : Math.max(a.y, b.y) + 8, up ? "above" : "below", col, this.size.w);
  }

  /** 價格範圍：兩點之間的垂直箭頭 + 上下橫線，標「差價（漲跌幅）跳動點數」。 */
  private drawPriceRange(ctx: CanvasRenderingContext2D, d: Drawing, a: XY, b: XY) {
    const [p1, p2] = d.pts;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), mx = (x0 + x1) / 2, w = Math.max(x1 - x0, 24);
    const left = mx - w / 2;
    ctx.setLineDash([]); ctx.strokeStyle = d.color; ctx.fillStyle = d.color; ctx.lineWidth = 1.5;
    ctx.save(); ctx.globalAlpha = 0.14; ctx.fillRect(left, Math.min(a.y, b.y), w, Math.abs(b.y - a.y)); ctx.restore();
    ctx.beginPath(); ctx.moveTo(left, a.y); ctx.lineTo(left + w, a.y); ctx.moveTo(left, b.y); ctx.lineTo(left + w, b.y); ctx.stroke();
    arrow(ctx, { x: mx, y: a.y }, { x: mx, y: b.y });
    const diff = p2.p - p1.p, pct = p1.p ? (diff / p1.p) * 100 : 0;
    const tick = this.p?.series.options().priceFormat.minMove ?? 0.01;
    const sign = diff < 0 ? "−" : "";
    const txt = `${sign}${this.fmt(Math.abs(diff))} (${sign}${Math.abs(pct).toFixed(2)}%) ${Math.round(Math.abs(diff) / tick).toLocaleString("en-US")}`;
    const up = b.y <= a.y;
    label(ctx, [txt], mx, up ? b.y - 10 : b.y + 10, up ? "above" : "below", "#2c2f38", this.size.w);
  }

  private drawPosition(ctx: CanvasRenderingContext2D, d: Drawing, q: XY[], on: boolean) {
    const [e, t, s] = q, [pe, pt, ps] = d.pts;
    const x0 = Math.min(e.x, t.x), w = Math.abs(t.x - e.x);
    ctx.setLineDash([]);
    ctx.save(); ctx.globalAlpha = 0.18;
    ctx.fillStyle = UP; ctx.fillRect(x0, Math.min(e.y, t.y), w, Math.abs(t.y - e.y));
    ctx.fillStyle = DOWN; ctx.fillRect(x0, Math.min(e.y, s.y), w, Math.abs(s.y - e.y));
    ctx.restore();
    ctx.strokeStyle = "#8a909c"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, e.y); ctx.lineTo(x0 + w, e.y); ctx.stroke();
    if (!on) return;   // 沒選中只留色塊與進場線；數值標籤選中才顯示（跟 TradingView 一樣）
    const gain = Math.abs(pt.p - pe.p), loss = Math.abs(pe.p - ps.p);
    const pc = (v: number) => (pe.p ? ((v / pe.p) * 100).toFixed(3) : "0.000");
    const tick = this.p?.series.options().priceFormat.minMove ?? 0.01;
    const ticks = (v: number) => Math.round(v / tick).toLocaleString("en-US");
    const mx = x0 + w / 2;
    const above = d.kind === "long";
    label(ctx, [`目標：${this.fmt(gain)} (${pc(gain)}%) ${ticks(gain)}`], mx, above ? t.y - 6 : t.y + 6, above ? "above" : "below", UP, this.size.w);
    label(ctx, [`停損：${this.fmt(loss)} (${pc(loss)}%) ${ticks(loss)}`], mx, above ? s.y + 6 : s.y - 6, above ? "below" : "above", DOWN, this.size.w);
    const rr = loss > 0 ? (gain / loss).toFixed(2) : "—";
    label(ctx, [`進場：${this.fmt(pe.p)}`, `風險/報酬比：${rr}`], mx, e.y, "center", UP, this.size.w);
  }
}

interface Profile {
  lo: number; hi: number; step: number; up: Float64Array; dn: Float64Array; max: number; poc: number; vaLo: number; vaHi: number;
}

// ── 小工具 ──
function extend(a: XY, b: XY, back: boolean): [XY, XY] {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 0.5) return [a, b];
  const k = 20000 / len;
  return [back ? { x: a.x - dx * k, y: a.y - dy * k } : a, { x: b.x + dx * k, y: b.y + dy * k }];
}

function segDist(px: number, py: number, a: XY, b: XY) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

// 在框內算 0，框外算到邊的距離
function boxDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(Math.min(x1, x2) - px, 0, px - Math.max(x1, x2));
  const dy = Math.max(Math.min(y1, y2) - py, 0, py - Math.max(y1, y2));
  return Math.hypot(dx, dy);
}

function arrow(ctx: CanvasRenderingContext2D, a: XY, b: XY) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), n = 6;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  if (Math.hypot(b.x - a.x, b.y - a.y) > 12) {
    ctx.moveTo(b.x - n * Math.cos(ang - 0.5), b.y - n * Math.sin(ang - 0.5)); ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x - n * Math.cos(ang + 0.5), b.y - n * Math.sin(ang + 0.5));
  }
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, lines: string[], cx: number, y: number,
  where: "above" | "below" | "center", back: string, maxW: number) {
  ctx.save();
  ctx.font = FONT; ctx.setLineDash([]);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, h = lines.length * 15 + 7;
  const x = Math.max(4, Math.min(maxW - w - 4, cx - w / 2));
  const top = where === "above" ? y - h : where === "below" ? y : y - h / 2;
  ctx.globalAlpha = 0.94; ctx.fillStyle = back;
  ctx.beginPath(); ctx.roundRect(x, top, w, h, 4); ctx.fill();
  ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, top + 11 + i * 15));
  ctx.restore();
}

function compact(v: number): string {
  return v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(0);
}

function span(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 1) return h ? `${d} 天 ${h} 時` : `${d} 天`;
  if (h >= 1) return m ? `${h} 時 ${m} 分` : `${h} 時`;
  return `${m} 分`;
}
