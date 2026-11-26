// 畫圖互動：放點、選取、拖曳、刪除、復原 / 重做、磁鐵吸附。純 TypeScript，不依賴 React。
// 用 pointer 事件自己判斷（lightweight-charts 的 click 會吞掉 500ms 內的第二下）；
// 自己在處理時把圖表的平移 / 縮放關掉，放開再打開。
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import type { Drawing, Kind, Pt, Tool } from "../types";
import {
  ACCENT, DOWN, DrawLayer, FIB_DEFAULT, FIB_OPTS, FIBX_DEFAULT, FIBX_OPTS, FRVP_OPTS, HIT_TOL, HIT_TOL_TOUCH, NEED, UP,
  applyHandle, newId, type Hit,
} from "./layer";

export interface DrawState {
  selected: Drawing | null;
  count: number;
  canUndo: boolean;
  canRedo: boolean;
  hidden: boolean;
  drafting: boolean;
}

interface Callbacks {
  onState(s: DrawState): void;
  onChange(items: Drawing[]): void;        // 圖形有變 → 存檔
  onToolDone(): void;                      // 畫完一個 → 工具回到游標
  onEditText(d: Drawing): void;            // 文字工具放好後開輸入框
  onSettings(d: Drawing): void;            // 在圖形上連點兩下 → 開設定頁
}

const CLICK_PX = 6;
const PINCH_GAIN = 1.15;  // 1 = 跟手指距離等比例；越大縮放越快（1.7 實測太快）

export class DrawController {
  items: Drawing[] = [];
  private selected: string | null = null;
  private tool: Tool = "cursor";
  private magnet = false;
  private hidden = false;
  private draft: { kind: Kind; pts: Pt[] } | null = null;
  private cursor: Pt | null = null;
  private marker: Pt | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private style = { color: ACCENT, width: 2, dash: 0 };
  private down: { x: number; y: number; started: boolean } | null = null;
  private drag: { hit: Hit; from: Drawing; x: number; y: number; before: string; moved: boolean; dbl: boolean } | null = null;
  private blankDown: { x: number; y: number } | null = null;
  private lastTap = { id: "", at: 0 };
  // 觸控畫圖（照 TradingView 手機 app）：選了工具先出現虛線十字，拖曳是移動十字（相對位移，手指不擋住），
  // 第一下點擊把十字移到那裡，之後再點一下才真的放點。滑鼠不走這套，維持點哪放哪。
  private aim: { x: number; y: number; armed: boolean } | null = null;
  private aimDrag: { x: number; y: number; ax: number; ay: number; moved: boolean } | null = null;
  private locked = false;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; from: number; to: number; lm: number; mx0: number; w: number } | null = null;
  private swallow = false;   // 縮放結束後還留在螢幕上的那根手指：放開前都不算點擊 / 拖曳
  // 觸控按在「還沒選中」的圖形上：先不決定。手指有移動 = 滑畫面（圖表自己平移），沒移動就放開 = 選中。
  // 只有已經選中的圖形，按住拖才是移動它（跟 TradingView 一樣，滑畫面時不會誤選、誤拖）。
  private tapSel: { id: string; x: number; y: number } | null = null;
  // 電腦版 Shift + 點（或拖）= 臨時量尺（跟 TradingView 一樣）：不存檔，下一次點擊就消失
  private probe: { pts: Pt[]; x: number; y: number; done: boolean } | null = null;

  constructor(private el: HTMLElement, private chart: IChartApi, private series: ISeriesApi<SeriesType>,
    private layer: DrawLayer, private cb: Callbacks) {
    el.addEventListener("pointerdown", this.onDown, true);
    el.addEventListener("pointermove", this.onHover);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    window.addEventListener("keydown", this.onKey);
  }

  destroy() {
    this.el.removeEventListener("pointerdown", this.onDown, true);
    this.el.removeEventListener("pointermove", this.onHover);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    window.removeEventListener("keydown", this.onKey);
  }

  // ── 外部操作 ──
  load(items: Drawing[]) {
    this.items = items; this.selected = null; this.draft = null; this.undoStack = []; this.redoStack = [];
    this.sync();
  }
  setTool(t: Tool) {
    if (t === this.tool) return;
    this.tool = t; this.draft = null; this.cursor = null; this.marker = null; this.aimDrag = null; this.probe = null;
    if (t !== "cursor") this.selected = null;
    this.el.style.cursor = t === "cursor" ? "" : "crosshair";
    const touch = window.matchMedia("(pointer: coarse)").matches;
    this.aim = t !== "cursor" && touch ? { x: this.layer.size.w / 2, y: this.layer.size.h * 0.45, armed: false } : null;
    this.lockChart(!!this.aim);     // 瞄準期間拖曳是移動十字，不是平移圖表
    if (this.aim) this.aimCursor(false);
    this.sync();
  }
  setMagnet(on: boolean) { this.magnet = on; }
  toggleHidden() { this.hidden = !this.hidden; this.selected = null; this.sync(); }
  undo() { this.step(this.undoStack, this.redoStack); }
  redo() { this.step(this.redoStack, this.undoStack); }
  clearAll() { if (this.items.length) this.commit(() => { this.items = []; this.selected = null; }); }
  removeSelected() {
    if (!this.selected) return;
    this.commit(() => { this.items = this.items.filter((d) => d.id !== this.selected); this.selected = null; });
  }
  /** 改選中圖形的屬性（顏色、粗細、線型、鎖定、文字、Fib 層級）；顏色等會記成之後新圖形的預設。 */
  patchSelected(patch: Partial<Drawing>) {
    if (!this.selected) return;
    for (const k of ["color", "width", "dash"] as const) {
      if (patch[k] != null) (this.style as Record<string, unknown>)[k] = patch[k];
    }
    this.commit(() => { this.items = this.items.map((d) => (d.id === this.selected ? { ...d, ...patch } : d)); });
  }
  // ── 設定頁：改的時候只預覽（不進復原、不存檔），按確認才算一步、按取消整個還原 ──
  snapshot(): string { return JSON.stringify(this.items); }
  previewSelected(patch: Partial<Drawing>) {
    if (!this.selected) return;
    this.items = this.items.map((d) => (d.id === this.selected ? { ...d, ...patch } : d));
    this.sync();
  }
  finishEdit(before: string) {
    if (before === JSON.stringify(this.items)) return;
    const d = this.items.find((x) => x.id === this.selected);
    if (d) Object.assign(this.style, { color: d.color, width: d.width, dash: d.dash });
    if (d && !this.layer.shown(d)) this.selected = null;   // 這個週期設成不顯示：一起取消選取
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.sync();
    this.cb.onChange(this.items);
  }
  cancelEdit(before: string) {
    if (before === JSON.stringify(this.items)) return;
    this.items = JSON.parse(before);
    this.sync();
  }
  /** 「套用預設值」：這種工具出廠的樣式（不是上次用的顏色）。 */
  defaultStyle(kind: Kind): Partial<Drawing> {
    const saved = this.style;
    this.style = { color: ACCENT, width: 2, dash: 0 };
    const d = this.make(kind, []);
    this.style = saved;
    return { color: d.color, width: d.width, dash: d.dash, levels: d.levels, opts: d.opts, opacity: 1, textColor: undefined, hideOn: undefined };
  }
  /** 文字輸入框送出；空字串 = 刪掉這個文字圖形。 */
  setText(id: string, text: string) {
    this.commit(() => {
      this.items = text ? this.items.map((d) => (d.id === id ? { ...d, text } : d)) : this.items.filter((d) => d.id !== id);
      if (!text && this.selected === id) this.selected = null;
    });
  }
  /** 右鍵：點到哪個圖形就選中它並回傳；點空白回 null（並取消選取）。 */
  pickAt(x: number, y: number): Drawing | null {
    const hit = this.hidden ? null : this.layer.hit(x, y, HIT_TOL);
    this.selected = hit ? hit.id : null;
    this.sync();
    return hit ? this.items.find((d) => d.id === hit.id) ?? null : null;
  }
  /** 複製選中的圖形，往右下偏一點放（像素空間平移，對數座標也正確）。 */
  duplicateSelected() {
    const d = this.items.find((x) => x.id === this.selected);
    if (!d) return;
    const pts: Pt[] = [];
    for (const p of d.pts) {
      const px = this.layer.xOf(p.t), py = this.layer.yOf(p.p);
      const np = px == null || py == null ? null : this.layer.fromPx(px + 24, py + 24);
      if (!np) return;
      pts.push(np);
    }
    const copy: Drawing = { ...JSON.parse(JSON.stringify(d)), id: newId(), pts, locked: false };
    this.commit(() => { this.items = [...this.items, copy]; this.selected = copy.id; });
  }
  /** 選中的圖形移到最上層 / 最下層（畫的順序 = 陣列順序）。 */
  orderSelected(front: boolean) {
    const d = this.items.find((x) => x.id === this.selected);
    if (!d) return;
    const rest = this.items.filter((x) => x.id !== d.id);
    this.commit(() => { this.items = front ? [...rest, d] : [d, ...rest]; });
  }
  /** 右鍵「在這個價位畫水平線」。 */
  addHline(price: number) {
    const d = this.make("hline", [{ t: this.layer.lToT(0), p: price }]);
    this.commit(() => { this.items = [...this.items, d]; this.selected = d.id; });
  }
  /** 圖形的螢幕座標（給文字輸入框定位）。 */
  anchor(d: Drawing): { x: number; y: number } | null {
    const x = this.layer.xOf(d.pts[0].t), y = this.layer.yOf(d.pts[0].p);
    return x == null || y == null ? null : { x, y };
  }

  // ── 內部 ──
  private commit(fn: () => void) {
    this.undoStack.push(JSON.stringify(this.items));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    fn();
    this.sync();
    this.cb.onChange(this.items);
  }
  private step(from: string[], to: string[]) {
    const snap = from.pop();
    if (snap == null) return;
    to.push(JSON.stringify(this.items));
    this.items = JSON.parse(snap);
    if (!this.items.some((d) => d.id === this.selected)) this.selected = null;
    this.sync();
    this.cb.onChange(this.items);
  }
  private sync() {
    let draft: Drawing | null = null;
    if (this.draft) {
      const pts = this.cursor && this.draft.pts.length < NEED[this.draft.kind]
        ? [...this.draft.pts, this.cursor] : this.draft.pts;
      draft = this.make(this.draft.kind, pts, "draft");
    } else if (this.probe) {
      const pts = !this.probe.done && this.cursor ? [this.probe.pts[0], this.cursor] : this.probe.pts;
      if (pts.length === 2) draft = this.make("measure", pts, "draft");
    }
    this.layer.set(this.items, this.selected, draft, this.marker, this.hidden, this.aim);
    this.el.style.touchAction = this.tool !== "cursor" || this.selected ? "none" : "";
    this.cb.onState({
      selected: this.items.find((d) => d.id === this.selected) ?? null,
      count: this.items.length, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      hidden: this.hidden, drafting: this.tool !== "cursor",
    });
  }
  private make(kind: Kind, pts: Pt[], id = newId()): Drawing {
    const d: Drawing = { id, kind, pts, ...this.style };
    if (kind === "fib") { d.levels = FIB_DEFAULT; d.opts = { ...FIB_OPTS }; }
    if (kind === "fibext") { d.levels = FIBX_DEFAULT; d.opts = { ...FIBX_OPTS }; }
    if (kind === "arrowup") d.color = UP;       // 箭頭預設綠漲紅跌，之後可在設定改色
    if (kind === "arrowdown") d.color = DOWN;
    if (kind === "frvp") d.opts = { ...FRVP_OPTS };
    if (kind === "text") d.text = "";
    return d;
  }
  // 鎖住的只有「拖曳平移」。縮放一律保留：滾輪、拖座標軸照常；雙指縮放由下面的 pinch 自己處理（內建的關掉）。
  private lockChart(lock: boolean) {
    this.locked = lock;
    if (!this.pinch && !this.swallow) this.chart.applyOptions({ handleScroll: !lock });
  }

  // ── 雙指縮放 ──
  // 自己做而不用內建的，原因有二：(1) 第二指落下時不管第一指按在圖形、把手還是瞄準十字上，一律改成縮放；
  // (2) 內建的縮放太慢，這裡用「手指距離比例的 PINCH_GAIN 次方」加快。縮放以兩指中點為錨，兩指一起移動可平移。
  private startPinch() {
    if (this.drag) {                       // 第一指正在拖圖形：還原，不算拖動
      if (this.drag.moved) this.items = JSON.parse(this.drag.before);
      this.drag = null; this.marker = null;
    }
    if (this.aimDrag && this.aim) { this.aim = { ...this.aim, x: this.aimDrag.ax, y: this.aimDrag.ay }; this.aimCursor(false); }
    this.aimDrag = null; this.down = null; this.blankDown = null; this.tapSel = null; this.lastTap = { id: "", at: 0 };
    this.locked = !!this.aim;              // 第一指碰到圖形時上的平移鎖要還原（瞄準模式才繼續鎖），不然縮放完圖表拖不動
    const [a, b] = [...this.touches.values()], ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange();
    const mx = (a.x + b.x) / 2, lm = ts.coordinateToLogical(mx);
    if (!r || lm == null) return;
    this.chart.applyOptions({ handleScroll: false });   // 縮放期間別讓第一指繼續平移
    this.pinch = { d0: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)), from: r.from, to: r.to, lm, mx0: mx, w: this.layer.size.w || 1 };
    this.sync();
  }
  private movePinch() {
    const g = this.pinch;
    if (!g || this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const ratio = Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)) / g.d0;
    const span0 = g.to - g.from, span = Math.max(8, Math.min(20000, span0 / ratio ** PINCH_GAIN));
    const k = span / span0, shift = (((a.x + b.x) / 2 - g.mx0) / g.w) * span;
    this.chart.timeScale().setVisibleLogicalRange({ from: g.lm - (g.lm - g.from) * k - shift, to: g.lm + (g.to - g.lm) * k - shift });
  }
  private xy(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  // 只有主圖範圍內才算（下方指標區、右側價格軸不放點）
  private inPane(x: number, y: number) {
    const { w, h } = this.layer.size;
    return x >= 0 && y >= 0 && x <= w && y <= h;
  }
  private snapOn(e: { ctrlKey: boolean; metaKey: boolean }) { return this.magnet || e.ctrlKey || e.metaKey; }

  // 多單 / 空單：點一下放進場價，停利、停損、寬度用目前畫面比例給預設值
  private positionPts(kind: "long" | "short", at: Pt): Pt[] {
    const { h } = this.layer.size;
    const top = this.series.coordinateToPrice(0) ?? at.p * 1.1, bot = this.series.coordinateToPrice(h) ?? at.p * 0.9;
    const range = Math.abs(top - bot) || at.p * 0.1;
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const nBars = Math.max(8, Math.round(((r?.to ?? 100) - (r?.from ?? 0)) * 0.18));
    const t2 = this.layer.lToT(this.layer.tToL(at.t) + nBars);
    const dir = kind === "long" ? 1 : -1;
    return [at, { t: t2, p: at.p + dir * range * 0.16 }, { t: t2, p: at.p - dir * range * 0.08 }];
  }

  // 十字目前指到的時間 / 價位（磁鐵開著就吸附），同時更新預覽用的游標點
  private aimCursor(snap: boolean): Pt | null {
    if (!this.aim) return null;
    const pt = this.layer.point(this.aim.x, this.aim.y, snap);
    this.cursor = pt ? { t: pt.t, p: pt.p } : null;
    this.marker = pt && snap ? { t: pt.t, p: pt.p } : null;
    return this.cursor;
  }

  private finish(kind: Kind, pts: Pt[]) {
    const d = this.make(kind, kind === "long" || kind === "short" ? this.positionPts(kind, pts[0]) : pts);
    this.draft = null; this.cursor = null; this.marker = null; this.tool = "cursor"; this.aim = null; this.aimDrag = null;
    this.lockChart(false);
    this.el.style.cursor = "";
    this.commit(() => { this.items = [...this.items, d]; this.selected = d.id; });
    this.cb.onToolDone();
    if (kind === "text") this.cb.onEditText(d);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const { x, y } = this.xy(e);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x, y });
      if (this.touches.size === 2) { this.startPinch(); return; }
      if (this.touches.size > 2 || this.swallow) return;
    }
    if (!this.inPane(x, y) || this.hidden) return;
    if (this.tool !== "cursor" && this.aim && e.pointerType !== "mouse") {
      this.aimDrag = { x, y, ax: this.aim.x, ay: this.aim.y, moved: false };
      return;
    }
    if (this.tool !== "cursor") {
      const pt = this.layer.point(x, y, this.snapOn(e));
      if (!pt) return;
      this.lockChart(true);
      let started = false;
      if (!this.draft) { this.draft = { kind: this.tool, pts: [{ t: pt.t, p: pt.p }] }; started = true; }
      this.down = { x, y, started };
      this.sync();
      return;
    }
    if (this.probe?.done) { this.probe = null; this.cursor = null; this.sync(); if (!e.shiftKey) return; }
    if (e.pointerType === "mouse" && (e.shiftKey || this.probe)) {
      const pt = this.layer.point(x, y, this.snapOn(e));
      if (!pt) return;
      if (this.probe) { this.probe.pts.push({ t: pt.t, p: pt.p }); this.probe.done = true; this.lockChart(false); }
      else { this.probe = { pts: [{ t: pt.t, p: pt.p }], x, y, done: false }; this.cursor = { t: pt.t, p: pt.p }; this.lockChart(true); }
      this.sync();
      return;
    }
    const hit = this.layer.hit(x, y, e.pointerType === "touch" ? HIT_TOL_TOUCH : HIT_TOL);
    if (!hit) { this.blankDown = { x, y }; return; }
    const from = this.items.find((d) => d.id === hit.id)!;
    if (e.pointerType === "touch" && this.selected !== hit.id) { this.tapSel = { id: hit.id, x, y }; return; }
    this.selected = hit.id;
    // 連點兩下要等放開、而且手指沒移動才算（選中後馬上按住拖是要移動圖形，不是開設定）
    const now = Date.now(), dbl = this.lastTap.id === hit.id && now - this.lastTap.at < 420;
    this.lastTap = dbl ? { id: "", at: 0 } : { id: hit.id, at: now };
    this.lockChart(true);
    this.drag = { hit, from, x, y, before: JSON.stringify(this.items), moved: false, dbl };
    this.sync();
  };

  private onHover = (e: PointerEvent) => {
    if (this.tool !== "cursor" || this.drag || e.pointerType !== "mouse" || e.buttons) return;
    const { x, y } = this.xy(e);
    const hit = this.inPane(x, y) ? this.layer.hit(x, y) : null;
    this.el.style.cursor = hit ? (hit.part === "body" ? "pointer" : "grab") : "";
  };

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.xy(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x, y });
      if (this.pinch) { this.movePinch(); return; }
      if (this.swallow) return;
    }
    if (this.aimDrag && this.aim) {
      const g = this.aimDrag, { w, h } = this.layer.size;
      if (!g.moved && Math.hypot(x - g.x, y - g.y) < CLICK_PX) return;
      g.moved = true;
      this.aim = { x: Math.max(0, Math.min(w, g.ax + x - g.x)), y: Math.max(0, Math.min(h, g.ay + y - g.y)), armed: true };
      this.aimCursor(this.snapOn(e));
      this.sync();
      return;
    }
    if (this.tool !== "cursor" && this.aim) return;
    if (this.probe && !this.probe.done && e.pointerType === "mouse") {
      const pt = this.layer.point(x, y, this.snapOn(e));
      this.cursor = pt ? { t: pt.t, p: pt.p } : null;
      this.sync();
      return;
    }
    if (this.tool !== "cursor") {
      if (!this.draft && e.pointerType !== "mouse") return;
      const pt = this.layer.point(x, y, this.snapOn(e));
      this.cursor = pt ? { t: pt.t, p: pt.p } : null;
      this.marker = pt && this.snapOn(e) ? { t: pt.t, p: pt.p } : null;
      this.sync();
      return;
    }
    const g = this.drag;
    if (!g || g.from.locked) return;
    if (!g.moved && Math.hypot(x - g.x, y - g.y) < 3) return;
    g.moved = true;
    let next: Drawing | null = null;
    if (g.hit.part === "body") {
      // 整個搬：每個點在像素空間平移同樣的距離再換回時間 / 價位（對數座標也正確）
      const pts: Pt[] = [];
      for (const p of g.from.pts) {
        const px = this.layer.xOf(p.t), py = this.layer.yOf(p.p);
        const np = px == null || py == null ? null : this.layer.fromPx(px + (x - g.x), py + (y - g.y));
        if (!np) return;
        pts.push(np);
      }
      next = { ...g.from, pts };
    } else {
      const pt = this.layer.point(x, y, this.snapOn(e));
      if (!pt) return;
      this.marker = this.snapOn(e) ? { t: pt.t, p: pt.p } : null;
      next = applyHandle(g.from, g.hit.part, { t: pt.t, p: pt.p });
    }
    this.items = this.items.map((d) => (d.id === g.from.id ? next! : d));
    this.sync();
  };

  private onUp = (e: PointerEvent) => {
    const { x, y } = this.xy(e);
    if (e.pointerType === "touch" && this.touches.delete(e.pointerId) && (this.pinch || this.swallow)) {
      if (this.pinch) { this.pinch = null; this.swallow = true; }
      if (this.touches.size === 0) {       // 手指全放開才恢復平移，不然剩下那指會從舊位置接著拖，畫面會跳
        this.swallow = false;
        this.chart.applyOptions({ handleScroll: !this.locked });
      }
      return;
    }
    if (this.tapSel) {
      const t = this.tapSel;
      this.tapSel = null;
      if (Math.hypot(x - t.x, y - t.y) < CLICK_PX && this.items.some((d) => d.id === t.id)) {
        this.selected = t.id;
        this.lastTap = { id: t.id, at: Date.now() };   // 緊接著再點一下 = 連點兩下開設定頁
        this.sync();
      }
      return;
    }
    if (this.aimDrag && this.aim) {
      const g = this.aimDrag;
      this.aimDrag = null;
      if (g.moved) return;                       // 拖曳只是移動十字
      if (!this.aim.armed) {                     // 第一下：十字跳到點的位置，還不放
        this.aim = { x, y, armed: true };
        this.aimCursor(this.snapOn(e));
        this.sync();
        return;
      }
      const pt = this.aimCursor(this.snapOn(e)); // 再點一下：在十字的位置放點
      if (!pt) return;
      const kind = this.tool as Kind;
      if (!this.draft) this.draft = { kind, pts: [] };
      this.draft.pts.push(pt);
      if (this.draft.pts.length >= NEED[kind]) this.finish(kind, this.draft.pts.slice(0, NEED[kind]));
      else this.sync();
      return;
    }
    if (this.down && this.draft) {
      const { started } = this.down;
      const moved = Math.hypot(x - this.down.x, y - this.down.y) > CLICK_PX;
      this.down = null;
      this.lockChart(false);
      const kind = this.draft.kind, need = NEED[kind];
      const pt = this.layer.point(x, y, this.snapOn(e));
      // 這一下剛放了第一點：單點工具直接完成；按住拖出去 = 第二點；只是點一下就等下一下
      if (!started || moved) { if (pt) this.draft.pts.push({ t: pt.t, p: pt.p }); }
      if (this.draft.pts.length >= need) this.finish(kind, this.draft.pts.slice(0, need));
      else this.sync();
      return;
    }
    this.down = null;
    if (this.probe && !this.probe.done && e.pointerType === "mouse" && Math.hypot(x - this.probe.x, y - this.probe.y) > CLICK_PX) {
      const pt = this.layer.point(x, y, this.snapOn(e));   // 按住拖出去放開 = 量完
      if (pt) { this.probe.pts.push({ t: pt.t, p: pt.p }); this.probe.done = true; this.lockChart(false); this.sync(); }
      return;
    }
    if (this.drag) {
      const g = this.drag;
      this.drag = null; this.marker = null;
      this.lockChart(false);
      if (g.moved) {
        this.undoStack.push(g.before);
        this.redoStack = [];
        this.cb.onChange(this.items);
      }
      this.sync();
      if (!g.moved && g.dbl) this.cb.onSettings(g.from);
      return;
    }
    if (this.blankDown) {   // 點空白處（沒拖動）= 取消選取
      const b = this.blankDown;
      this.blankDown = null;
      if (this.selected && Math.hypot(x - b.x, y - b.y) < CLICK_PX) { this.selected = null; this.sync(); }
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      if (this.probe) { this.probe = null; this.cursor = null; this.lockChart(false); this.sync(); return; }
      if (this.draft || this.tool !== "cursor") {
        this.draft = null; this.cursor = null; this.marker = null; this.tool = "cursor"; this.el.style.cursor = "";
        this.aim = null; this.aimDrag = null;
        this.lockChart(false); this.sync(); this.cb.onToolDone();
      } else if (this.selected) { this.selected = null; this.sync(); }
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
      e.preventDefault(); this.removeSelected();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
    } else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); }
  };
}
