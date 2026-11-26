// 圖形設定頁：在圖形上連點兩下（或工具列齒輪）打開。版面仿 TradingView 手機版：
// 標題可改名、樣式 / 文字 / 坐標 / 可見性 四個分頁、左下「…」= 模板（另存為、套用預設值、已存的模板）、取消 / 確認。
// 改的時候只預覽；確認才進復原紀錄並存檔，取消或關閉整個還原。
import { useEffect, useRef, useState } from "react";
import type { DrawController } from "../draw/controller";
import { FIB_ALL, FIB_DEFAULT, FIB_OPTS, FIBX_ALL, FIBX_DEFAULT, FIBX_OPTS, FRVP_OPTS, LINE_TEXT, withAlpha } from "../draw/layer";
import type { Drawing, DrawTpl } from "../types";
import { Icon } from "./icons";
import { Sheet } from "./sheet";

export const KIND_NAME: Record<string, string> = {
  trend: "趨勢線", ray: "射線", ext: "延長線", hline: "水平線", hray: "水平射線", vline: "垂直線", channel: "平行通道",
  rect: "矩形", fib: "斐波那契回撤", text: "文字", measure: "價格與日期範圍", long: "多頭倉位", short: "空頭倉位", frvp: "FRVP", prange: "價格範圍",
  drange: "日期範圍", arrowup: "向上箭頭", arrowdown: "向下箭頭", plabel: "價格標籤", fibext: "斐波那契延伸",
};

// 色盤：一排灰階、一排鮮色、六排深淺（Material 色系）
const GRAYS = ["#ffffff", "#d1d4dc", "#b2b5be", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000"];
const VIVID = ["#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63"];
const SHADES = [
  ["#fccbcd", "#ffe0b2", "#fff9c4", "#c8e6c9", "#ace5dc", "#b2ebf2", "#bbd9fb", "#d1c4e9", "#e1bee7", "#f8bbd0"],
  ["#faa1a4", "#ffcc80", "#fff59d", "#a5d6a7", "#70ccbd", "#80deea", "#90bff9", "#b39ddb", "#ce93d8", "#f48fb1"],
  ["#f77c80", "#ffb74d", "#fff176", "#81c784", "#42bda8", "#4dd0e1", "#5b9cf6", "#9575cd", "#ba68c8", "#f06292"],
  ["#f7525f", "#ffa726", "#ffee58", "#66bb6a", "#22ab94", "#26c6da", "#3179f5", "#7e57c2", "#ab47bc", "#ec407a"],
  ["#b22833", "#f57c00", "#fbc02d", "#388e3c", "#056656", "#0097a7", "#1848cc", "#512da8", "#7b1fa2", "#c2185b"],
  ["#801922", "#e65100", "#f57f17", "#1b5e20", "#00332a", "#006064", "#0c3299", "#311b92", "#4a148c", "#880e4f"],
];
const SIZES = [10, 11, 12, 14, 16, 20, 24, 28];
const VIS: [string, string][] = [["m", "分鐘"], ["h", "小時"], ["d", "日"], ["w", "週"], ["M", "月"]];
const FILL_ONLY = new Set(["arrowup", "arrowdown", "plabel", "text"]);   // 只有顏色，沒有粗細 / 線型
const NO_STYLE = new Set(["fib", "fibext", "frvp", "long", "short", "measure"]);   // 顏色由工具自己決定

/** 模板存的欄位：樣式＋文字＋可見性，不含位置、鎖定、名稱。 */
function styleOf(d: Drawing): Partial<Drawing> {
  const { color, width, dash, opacity, opts, levels, text, textColor, hideOn } = d;
  return JSON.parse(JSON.stringify({ color, width, dash, opacity, opts, levels, text, textColor, hideOn }));
}

function ColorPop({ color, opacity, width, dash, lines, onPatch, onClose }: {
  color: string; opacity: number; width?: number; dash?: number; lines: boolean;
  onPatch(p: Partial<Drawing>): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const t = window.setTimeout(() => document.addEventListener("pointerdown", out), 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", out); };
  }, [onClose]);
  const sw = (c: string) => (
    <button key={c} className={`cp-sw${c.toLowerCase() === color.toLowerCase() ? " on" : ""}`} style={{ background: c }}
      aria-label={`顏色 ${c}`} onClick={() => onPatch({ color: c })} />
  );
  const pct = Math.round(opacity * 100);
  return (
    <div className="cpop" ref={ref} role="dialog" aria-label="顏色與線條">
      <div className="cp-grid">{GRAYS.map(sw)}</div>
      <div className="cp-grid">{VIVID.map(sw)}</div>
      <div className="cp-grid shades">{SHADES.flat().map(sw)}</div>
      <hr />
      <label className="cp-custom" aria-label="自訂顏色">
        <Icon name="plus" size={20} />
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2962ff"} onChange={(e) => onPatch({ color: e.target.value })} />
      </label>
      <div className="cp-label">不透明度</div>
      <div className="cp-op">
        <input type="range" min={0} max={100} value={pct} aria-label="不透明度"
          style={{ background: `linear-gradient(90deg, transparent, ${color})` }}
          onChange={(e) => onPatch({ opacity: Number(e.target.value) / 100 })} />
        <span>{pct}%</span>
      </div>
      {lines && <>
        <div className="cp-label">厚度</div>
        <div className="cp-seg">
          {[1, 2, 3, 4].map((w) => (
            <button key={w} className={width === w ? "on" : ""} aria-label={`${w}px`} onClick={() => onPatch({ width: w })}>
              <i style={{ height: w }} /></button>
          ))}
        </div>
        <div className="cp-label">線條樣式</div>
        <div className="cp-seg">
          {["實線", "虛線", "點線"].map((n, i) => (
            <button key={n} className={dash === i ? "on" : ""} aria-label={n} onClick={() => onPatch({ dash: i })}>
              <i className={`ls ls${i}`} /></button>
          ))}
        </div>
      </>}
    </div>
  );
}

// 時間：UTC 秒 ↔ <input type="datetime-local"> 的本地時間字串
const toLocal = (t: number) => {
  const d = new Date(t * 1000), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (s: string) => { const ms = new Date(s).getTime(); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };

export function DrawingSettings({ d, ctrl, tpls, onTpls, onClose }: {
  d: Drawing; ctrl: DrawController; tpls: DrawTpl[]; onTpls(list: DrawTpl[]): void; onClose(): void;
}) {
  const before = useRef(ctrl.snapshot());
  const [tab, setTab] = useState("style");
  const [pop, setPop] = useState<"" | "line" | "text">("");
  const [more, setMore] = useState(false);
  const [naming, setNaming] = useState(false);
  const set = (patch: Partial<Drawing>) => ctrl.previewSelected(patch);
  const cancel = () => { ctrl.cancelEdit(before.current); onClose(); };
  const ok = () => { ctrl.finishEdit(before.current); onClose(); };

  const fx = d.kind === "fibext";
  const opts = { ...(d.kind === "fib" ? FIB_OPTS : fx ? FIBX_OPTS : d.kind === "frvp" ? FRVP_OPTS : {}), ...d.opts } as Record<string, number | boolean>;
  const opt = (k: string, v: number | boolean) => set({ opts: { ...opts, [k]: v } });
  const check = (label: string, on: boolean, toggle: () => void) => (
    <button className="cfg-check" role="checkbox" aria-checked={on} onClick={toggle}><i className={on ? "on" : ""} />{label}</button>
  );
  const num = (label: string, k: string, min: number, max: number) => (
    <label className="cfg-row"><span>{label}</span>
      <input className="num-in" type="number" inputMode="numeric" defaultValue={Number(opts[k])} min={min} max={max}
        onChange={(e) => { const v = Number(e.target.value); if (v >= min && v <= max) opt(k, v); }} />
    </label>
  );
  const lv = d.levels ?? (fx ? FIBX_DEFAULT : FIB_DEFAULT);
  const hasText = LINE_TEXT.has(d.kind) || d.kind === "text";
  const tabs: [string, string][] = [["style", "樣式"], ...(hasText ? [["text", "文字"] as [string, string]] : []), ["coord", "坐標"], ["vis", "可見性"]];
  const op = d.opacity ?? 1;
  const swatch = (c: string, lineW?: number, dash?: number) => (
    <span className="cfg-swatch">
      <i className="sq" style={{ background: withAlpha(c, op) }} />
      {lineW != null && <i className={`ln ls${dash ?? 0}`} style={{ borderTopWidth: lineW, borderTopColor: withAlpha(c, op) }} />}
    </span>
  );

  // 模板
  const saveAs = () => {
    setMore(false);
    const name = window.prompt("模板名稱", "")?.trim();
    if (!name) return;
    const rest = tpls.filter((t) => t.name !== name);
    if (rest.length !== tpls.length && !window.confirm(`已經有「${name}」，要覆蓋嗎？`)) return;
    onTpls([...rest, { name, s: styleOf(d) }].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")));
  };
  const applyTpl = (t: DrawTpl) => { setMore(false); set(JSON.parse(JSON.stringify(t.s))); };

  const pts = d.pts;
  const ptLabel = (i: number) => (d.kind === "long" || d.kind === "short" ? ["進場", "停利", "停損"][i] : pts.length > 1 ? `第 ${i + 1} 點` : "位置");

  return (
    <Sheet title="" onClose={cancel} head={
      <div className="ds-head">
        {naming ? (
          <input className="ds-name" autoFocus defaultValue={d.name ?? KIND_NAME[d.kind] ?? ""} maxLength={40} aria-label="圖形名稱"
            onBlur={(e) => { set({ name: e.target.value.trim() || undefined }); setNaming(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        ) : (
          <button className="ds-title" onClick={() => setNaming(true)} aria-label="改名">
            {d.name || KIND_NAME[d.kind] || "圖形"}<Icon name="edit" size={18} />
          </button>
        )}
        <div className="ds-tabs" role="tablist">
          {tabs.map(([id, n]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => { setTab(id); setPop(""); }}>{n}</button>
          ))}
        </div>
      </div>
    } foot={
      <div className="cfg-foot ds-foot">
        <div className="ds-more-wrap">
          <button className="cfg-btn ds-more" aria-label="模板" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" size={22} /></button>
          {more && (
            <div className="ds-menu" role="menu">
              <button role="menuitem" onClick={saveAs}>另存為…</button>
              <button role="menuitem" onClick={() => { setMore(false); set(ctrl.defaultStyle(d.kind)); }}>套用預設值</button>
              {tpls.length > 0 && <hr />}
              <div className="ds-tpls">
                {tpls.map((t) => (
                  <div key={t.name} className="ds-tpl">
                    <button role="menuitem" onClick={() => applyTpl(t)}>{t.name}</button>
                    <button className="icon-btn" aria-label={`刪除模板 ${t.name}`}
                      onClick={() => { if (window.confirm(`刪除模板「${t.name}」？`)) onTpls(tpls.filter((x) => x !== t)); }}>
                      <Icon name="trash" size={18} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="ds-gap" />
        <button className="cfg-btn" onClick={cancel}>取消</button>
        <button className="cfg-btn solid" onClick={ok}>確認</button>
      </div>
    }>
      {tab === "style" && (
        <section className="cfg-sec ds-sec">
          {!NO_STYLE.has(d.kind) && (
            <div className="ds-row">
              <span>{FILL_ONLY.has(d.kind) ? "顏色" : "線形圖"}</span>
              <div className="ds-pop-wrap">
                <button className={`ds-pick${pop === "line" ? " on" : ""}`} onClick={() => setPop(pop === "line" ? "" : "line")}>
                  {swatch(d.color, FILL_ONLY.has(d.kind) ? undefined : d.width, d.dash)}
                </button>
                {pop === "line" && <ColorPop color={d.color} opacity={op} width={d.width} dash={d.dash} lines={!FILL_ONLY.has(d.kind)}
                  onPatch={set} onClose={() => setPop("")} />}
              </div>
            </div>
          )}
          {(d.kind === "hline" || d.kind === "hray") && check("價格標籤", opts.plab !== false, () => opt("plab", opts.plab === false))}
          {d.kind === "frvp" && <>
            <h3>輸入</h3>
            {num("行數", "rows", 10, 1000)}
            {num("數值區成交量（%）", "va", 1, 100)}
            {check("向右延伸", !!opts.extend, () => opt("extend", !opts.extend))}
            <h3>樣式</h3>
            {num("寬度（範圍的 %）", "width", 5, 100)}
            {check("VAH", !!opts.vah, () => opt("vah", !opts.vah))}
            {check("VAL", !!opts.val, () => opt("val", !opts.val))}
            {check("POC", !!opts.poc, () => opt("poc", !opts.poc))}
          </>}
          {(d.kind === "fib" || fx) && <>
            {check("趨勢線", !!opts.trend, () => opt("trend", !opts.trend))}
            {check("背景", !!opts.bg, () => opt("bg", !opts.bg))}
            {check("標籤顯示價格", !!opts.price, () => opt("price", !opts.price))}
            <h3>層級</h3>
            <div className="cfg-levels">
              {(fx ? FIBX_ALL : FIB_ALL).map((r) => check(String(r), lv.includes(r), () => set({ levels: lv.includes(r) ? lv.filter((x) => x !== r) : [...lv, r] })))}
            </div>
          </>}
          {check("鎖定（不能拖動）", !!d.locked, () => set({ locked: !d.locked }))}
        </section>
      )}

      {tab === "text" && (
        <section className="cfg-sec ds-sec">
          <textarea className="ds-text" rows={3} value={d.text ?? ""} placeholder={d.kind === "text" ? "輸入文字" : "線上要顯示的文字（可留空）"}
            onChange={(e) => set({ text: e.target.value })} />
          {d.kind !== "text" && <>
            <div className="ds-row">
              <span>文字顏色</span>
              <div className="ds-pop-wrap">
                <button className={`ds-pick${pop === "text" ? " on" : ""}`} onClick={() => setPop(pop === "text" ? "" : "text")}>
                  {swatch(d.textColor ?? d.color)}
                </button>
                {pop === "text" && <ColorPop color={d.textColor ?? d.color} opacity={op} lines={false}
                  onPatch={(p) => set(p.color ? { textColor: p.color } : p)} onClose={() => setPop("")} />}
              </div>
            </div>
            <div className="ds-row"><span>大小</span>
              <div className="cp-seg ds-seg ds-wrap">
                {SIZES.map((s) => <button key={s} className={Number(opts.tsz ?? 13) === s ? "on" : ""} onClick={() => opt("tsz", s)}>{s}</button>)}
              </div>
            </div>
            <div className="ds-row"><span>水平位置</span>
              <div className="cp-seg ds-seg">
                {["左", "中", "右"].map((n, i) => <button key={n} className={Number(opts.tal ?? 2) === i ? "on" : ""} onClick={() => opt("tal", i)}>{n}</button>)}
              </div>
            </div>
            <div className="ds-row"><span>垂直位置</span>
              <div className="cp-seg ds-seg">
                {["線上方", "線下方"].map((n, i) => <button key={n} className={Number(opts.tvp ?? 0) === i ? "on" : ""} onClick={() => opt("tvp", i)}>{n}</button>)}
              </div>
            </div>
          </>}
        </section>
      )}

      {tab === "coord" && (
        <section className="cfg-sec ds-sec">
          {pts.map((p, i) => (
            <div key={i} className="ds-coord">
              <h3>{ptLabel(i)}</h3>
              {d.kind !== "vline" && (
                <label className="cfg-row"><span>價格</span>
                  <input className="num-in alert-in" inputMode="decimal" defaultValue={String(+p.p.toPrecision(10))}
                    onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) set({ pts: pts.map((x, j) => (j === i ? { ...x, p: v } : x)) }); }} />
                </label>
              )}
              {d.kind !== "hline" && (
                <label className="cfg-row"><span>時間</span>
                  <input className="num-in alert-in" type="datetime-local" defaultValue={toLocal(p.t)}
                    onChange={(e) => { const t = fromLocal(e.target.value); if (t != null) set({ pts: pts.map((x, j) => (j === i ? { ...x, t } : x)) }); }} />
                </label>
              )}
            </div>
          ))}
        </section>
      )}

      {tab === "vis" && (
        <section className="cfg-sec ds-sec">
          <p className="alert-hint">取消勾選的週期就不顯示這個圖形。</p>
          {VIS.map(([g, n]) => check(n, !d.hideOn?.includes(g), () => {
            const h = d.hideOn ?? [];
            const next = h.includes(g) ? h.filter((x) => x !== g) : [...h, g];
            set({ hideOn: next.length ? next : undefined });
          }))}
        </section>
      )}
    </Sheet>
  );
}
