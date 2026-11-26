import { useRef, type ReactNode } from "react";
import { Icon } from "./icons";

/** 底部彈出頁：抓著標題列往下拖超過 90px 就關閉。 */
export function Sheet({ title, onClose, children, foot, head }: {
  title: string; onClose(): void; children: ReactNode; foot?: ReactNode; head?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const move = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    ref.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !ref.current) return;
    if (d.dy > 90) onClose();
    else ref.current.style.transform = "";
  };
  return (
    <div className="sheet-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head" onPointerDown={(e) => { drag.current = { y: e.clientY, dy: 0 }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
          <i className="sheet-grab" />
          {title && <b>{title}</b>}
          <button className="m-x" aria-label="關閉" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}><Icon name="close" size={19} /></button>
        </header>
        {head}
        <div className="sheet-body">{children}</div>
        {foot && <footer className="sheet-foot">{foot}</footer>}
      </div>
    </div>
  );
}
