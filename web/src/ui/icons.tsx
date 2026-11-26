import { useState } from "react";

// 自己畫的線條圖示（24×24，stroke 用 currentColor）
const P: Record<string, JSX.Element> = {
  cursor: <path d="M6 4l11 8-5 1 3 6-2 1-3-6-4 3z" />,
  trend: <><path d="M5 18L19 6" /><circle cx="5" cy="18" r="1.8" /><circle cx="19" cy="6" r="1.8" /></>,
  ray: <><path d="M5 17L21 7" /><circle cx="5" cy="17" r="1.8" /><circle cx="12" cy="12.6" r="1.8" /></>,
  ext: <><path d="M2 19L22 5" /><circle cx="8" cy="14.8" r="1.8" /><circle cx="16" cy="9.2" r="1.8" /></>,
  hline: <><path d="M2 12h20" /><circle cx="12" cy="12" r="1.8" /></>,
  hray: <><path d="M6 12h16" /><circle cx="6" cy="12" r="1.8" /></>,
  vline: <><path d="M12 2v20" /><circle cx="12" cy="12" r="1.8" /></>,
  channel: <><path d="M3 15L17 5M7 20L21 10" /><path d="M5 17.5L19 7.5" strokeDasharray="2 3" /></>,
  rect: <><rect x="4" y="6" width="16" height="12" /><circle cx="4" cy="6" r="1.6" /><circle cx="20" cy="18" r="1.6" /></>,
  fib: <path d="M3 5h18M3 10h18M3 14h18M3 19h18M6 5v14" />,
  text: <path d="M5 6h14M12 6v13M9 19h6" />,
  measure: <><path d="M4 16L16 4l4 4L8 20z" /><path d="M8 12l2 2M11 9l2 2M14 6l2 2" /></>,
  long: <><path d="M4 12h16" /><path d="M4 5h16v7H4z" fill="currentColor" fillOpacity=".25" stroke="none" /><path d="M12 10V4M9.5 6.5L12 4l2.5 2.5M4 19h16" /></>,
  short: <><path d="M4 12h16" /><path d="M4 12h16v7H4z" fill="currentColor" fillOpacity=".25" stroke="none" /><path d="M12 14v6M9.5 17.5L12 20l2.5-2.5M4 5h16" /></>,
  moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" fill="currentColor" stroke="none" />,
  sun: <><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" /></>,
  drange: <><path d="M4 4h16" /><path d="M4 20V8M20 20V8" /><path d="M7 14h10M9.5 11.5L7 14l2.5 2.5M14.5 11.5L17 14l-2.5 2.5" /></>,
  arrowup: <path d="M12 3l7 8h-4.2v10H9.2V11H5z" fill="currentColor" fillOpacity=".25" />,
  arrowdown: <path d="M12 21l7-8h-4.2V3H9.2v10H5z" fill="currentColor" fillOpacity=".25" />,
  plabel: <><path d="M4 5h16v10h-6l-2 4-2-4H4z" /><path d="M8 10h8" /></>,
  fibext: <><path d="M3 20l5-9 4 4" strokeDasharray="2 2.5" /><path d="M12 15h9M12 10h9M12 4h9" /></>,
  prange: <><path d="M6 4h12M6 20h12M12 20V5" /><path d="M9 8l3-3 3 3" /></>,
  frvp: <><path d="M5 3v18" /><path d="M5 6h6M5 9.5h11M5 13h14M5 16.5h8M5 20h4" strokeWidth="2.2" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
  magnet: <path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4zM6 8h4M14 8h4" />,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M4 4l16 16M9.5 5.4A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.3 7.2A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  undo: <path d="M8 5L4 9l4 4M4 9h10a6 6 0 010 12h-3" />,
  redo: <path d="M16 5l4 4-4 4M20 9H10a6 6 0 000 12h3" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></>,
  list: <path d="M4 6h16M4 12h16M4 18h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  indicator: <path d="M3 17l5-6 4 3 5-8 4 4M3 21h18" />,
  end: <path d="M5 6l7 6-7 6M13 6l7 6-7 6" />,
  chevron: <path d="M6 15l6-6 6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  pen: <><path d="M4 20l1-4L16 5l3 3L8 19z" /><path d="M14 7l3 3M4 20h6" /></>,
  more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" fill="currentColor" stroke="none" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
  chevronRight: <path d="M9 5l7 7-7 7" strokeWidth="2.6" />,
  starLine: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" />,
  grip: <><circle cx="9" cy="6" r="1.3" fill="currentColor" /><circle cx="15" cy="6" r="1.3" fill="currentColor" /><circle cx="9" cy="12" r="1.3" fill="currentColor" />
    <circle cx="15" cy="12" r="1.3" fill="currentColor" /><circle cx="9" cy="18" r="1.3" fill="currentColor" /><circle cx="15" cy="18" r="1.3" fill="currentColor" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth="2" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v6M12 7.5v.5" strokeWidth="1.9" /></>,
  candle: <><path d="M8 3v3M8 17v4M16 5v4M16 17v3" /><rect x="5.5" y="6" width="5" height="11" rx=".5" /><rect x="13.5" y="9" width="5" height="8" rx=".5" fill="currentColor" /></>,
  lineChart: <path d="M3 17l5-6 4 3 5-7 4 4" strokeWidth="1.8" />,
  watchIc: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 9h8M8 12.5h8M8 16h5" /></>,
  fx: <path d="M11 4.5h-1.2a2.3 2.3 0 00-2.3 2.3V20M4.5 10h6M13 11l6.5 8M19.5 11L13 19" strokeWidth="1.8" />,
  alarm: <><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.2 1.6M4.5 5.5l2.5-2M19.5 5.5l-2.5-2" /></>,
  alarmPlus: <><circle cx="11" cy="13" r="7" /><path d="M11 9.5V13l2 1.4M3.5 5.5l2.5-2M18.5 5.5l-2.5-2M19 15.5v5M16.5 18h5" /></>,
  plusCircle: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
  full: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
};

const PALETTE = ["#f7931a", "#627eea", "#14b8a6", "#f0b90b", "#e5484d", "#8b5cf6", "#2f6bff", "#22c55e", "#ec4899", "#64748b"];

/** 商品圓形圖示：有 logo 用 logo，沒有就用代號算固定顏色 + 開頭字。 */
export function SymIcon({ sym, size = 40 }: { sym: { market: string; symbol: string; name: string }; size?: number }) {
  const base = sym.market === "crypto" ? sym.symbol.replace(/(USDT|USDC|BTC)$/, "") || sym.symbol : sym.symbol.replace("^", "");
  // 依序退：TradingView logo（後端，滿版方形，這裡裁成圓）→ 加密用內建 cryptocurrency-icons（CC0）→ 代號色塊
  const [bad, setBad] = useState<Record<string, number>>({});
  const step = bad[base] ?? 0;
  const fail = () => setBad((b) => ({ ...b, [base]: step + 1 }));
  // 指數 / 期貨（^ 或 =）也要：後端有對照表的會回 logo，沒有就 404 退回色塊
  if (step === 0) {
    // v= 換圖時讓瀏覽器快取失效
    return <img className="sym-icon" src={`/api/logo?market=${sym.market}&symbol=${encodeURIComponent(sym.symbol)}&v=3`} alt=""
      width={size} height={size} loading="lazy" onError={fail} />;
  }
  if (sym.market === "crypto" && step <= 1) {
    return <img className="sym-icon" src={`/coins/${base.toLowerCase()}.svg`} alt="" width={size} height={size} onError={fail} />;
  }
  let h = 0;
  for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const text = sym.market === "tw" ? (sym.name || base).slice(0, 1) : base.slice(0, base.length <= 3 ? 3 : 1);
  return (
    <span className="sym-icon" aria-hidden="true" style={{
      width: size, height: size, background: PALETTE[h % PALETTE.length],
      fontSize: Math.round(size * (text.length > 1 ? 0.34 : 0.5)),
    }}>{text}</span>
  );
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
  );
}
