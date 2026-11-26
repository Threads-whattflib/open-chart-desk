import { useRef, useState } from "react";

type Drag = { from: number; to: number; dy: number; h: number };

const LONG_PRESS = 380;   // 手指按住多久算「拿起來」（ms）
const SLOP = 8;           // 拿起來之前手指移動超過這麼多 = 使用者在捲動，不拖
const EDGE = 56;          // 拖到捲動區上下緣這個距離內就自動捲

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/**
 * 清單拖曳排序，不用套件。
 * - 手機：長按一列拿起來拖；或按住把手（now=true）立刻拖。
 * - 電腦：滑鼠按住拖超過幾像素就開始拖。
 * 拖動中只用 transform 讓其他列讓位，放開才呼叫 onMove(from, to) 真的改順序。
 * 拖完放開後那一下 click 不算點擊（blocked() 回 true），免得順便切換商品。
 */
export function useDragSort(onMove: (from: number, to: number) => void) {
  const ref = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const block = useRef(false);

  const start = (i: number, e: React.PointerEvent, now = false) => {
    if (e.button !== 0 || !ref.current) return;
    const id = e.pointerId, y0 = e.clientY, mouse = e.pointerType === "mouse";
    let active = false, lastY = y0, to = i, timer = 0, raf = 0, s0 = 0;
    let mids: number[] = [], h = 0, scroller: HTMLElement | null = null;

    const update = () => {
      const dy = lastY - y0 + ((scroller?.scrollTop ?? 0) - s0);
      const c = mids[i] + dy;
      let t = i;
      for (let k = i + 1; k < mids.length; k++) if (mids[k] < c) t = k;
      for (let k = i - 1; k >= 0; k--) if (mids[k] > c) t = k;
      to = t;
      setDrag({ from: i, to: t, dy, h });
    };
    const tick = () => {   // 拖到上下緣：自動捲
      if (!active) return;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const v = lastY < r.top + EDGE ? -1 : lastY > r.bottom - EDGE ? 1 : 0;
        if (v) { scroller.scrollTop += v * 9; update(); }
      }
      raf = requestAnimationFrame(tick);
    };
    const activate = () => {
      const lis = Array.from(ref.current?.children ?? []) as HTMLElement[];
      if (!lis[i]) return cleanup();
      scroller = scrollParent(ref.current);
      s0 = scroller?.scrollTop ?? 0;
      mids = lis.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
      h = lis[i].getBoundingClientRect().height;
      active = true;
      block.current = true;
      navigator.vibrate?.(10);
      setDrag({ from: i, to: i, dy: 0, h });
      raf = requestAnimationFrame(tick);
    };
    const onPMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      lastY = ev.clientY;
      if (active) return update();
      if (Math.abs(lastY - y0) > (mouse ? 4 : SLOP)) {
        if (mouse) { activate(); update(); } else cleanup();   // 手指還沒按夠久就動了 = 捲動
      }
    };
    const onTMove = (ev: TouchEvent) => { if (active) ev.preventDefault(); };   // 拖動中擋掉頁面捲動
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const was = active, from = i, dest = to;
      cleanup();
      if (was && ev.type === "pointerup" && dest !== from) onMove(from, dest);
    };
    function cleanup() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onPMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("touchmove", onTMove);
      if (active) {
        active = false;
        setDrag(null);
        window.setTimeout(() => { block.current = false; }, 350);
      }
    }
    document.addEventListener("pointermove", onPMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("touchmove", onTMove, { passive: false });
    if (now) activate();
    else if (!mouse) timer = window.setTimeout(activate, LONG_PRESS);
  };

  const style = (k: number): React.CSSProperties | undefined => {
    if (!drag) return undefined;
    const { from, to, dy, h } = drag;
    if (k === from) return { transform: `translateY(${dy}px)`, zIndex: 3, transition: "none" };
    const shift = from < k && k <= to ? -h : to <= k && k < from ? h : 0;
    return { transform: shift ? `translateY(${shift}px)` : undefined, transition: "transform .16s ease" };
  };

  return { ref, start, style, dragging: drag?.from ?? -1, blocked: () => block.current };
}

/** 陣列把第 from 個移到第 to 個。 */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const a = arr.slice();
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}
