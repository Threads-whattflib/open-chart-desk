import type { Bar, Drawing, Market, Sym } from "./types";

interface RawBars { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; more: boolean; name?: string }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch { /* 不是 JSON 就用狀態碼 */ }
    throw new Error(msg);
  }
  return r.json();
}

const put = (body: unknown): RequestInit => ({
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export async function fetchBars(market: Market, symbol: string, iv: string, to?: number, limit = 1000) {
  const q = new URLSearchParams({ market, symbol, iv, limit: String(limit) });
  if (to) q.set("to", String(to));
  const d = await j<RawBars>(`/api/bars?${q}`);
  const bars: Bar[] = d.t.map((t, i) => ({ t, o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i] }));
  return { bars, more: d.more, name: d.name };
}

export const searchSymbols = (q: string, m: string) =>
  j<Sym[]>(`/api/search?${new URLSearchParams({ q, m })}`);

// ext = 美股盤前 / 盤後 / 隔夜價（src: pre 盤前、post 盤後、token 隔夜用 bStock 代幣價），abs / chg 相對正規盤收盤
// a = 漲跌金額（後端算；舊資料沒有就用漲跌% 反推，會有四捨五入誤差）
export interface Quote { p: number; chg: number; a?: number; ext?: { p: number; chg: number; abs: number; src: "pre" | "post" | "token" } }
export const absChg = (q: Quote) => q.a ?? q.p - q.p / (1 + q.chg / 100);
// 後端一次最多收 60 檔（app.py），清單較長時拆批同時送再合併；某批失敗時其他批照用
const QUOTE_BATCH = 50;
export async function fetchQuotes(keys: string[]) {
  const parts: string[][] = [];
  for (let i = 0; i < keys.length; i += QUOTE_BATCH) parts.push(keys.slice(i, i + QUOTE_BATCH));
  const rs = await Promise.allSettled(parts.map((p) =>
    j<Record<string, Quote | null>>(`/api/quotes?items=${encodeURIComponent(p.join(","))}`)));
  const ok = rs.filter((r): r is PromiseFulfilledResult<Record<string, Quote | null>> => r.status === "fulfilled");
  if (!ok.length && rs.length) throw (rs[0] as PromiseRejectedResult).reason;
  return Object.assign({}, ...ok.map((r) => r.value)) as Record<string, Quote | null>;
}

// 價格提醒（後端內建：server/alerts.py）
export interface Alert { id: number; price: number; dir: "above" | "below"; note: string; at?: string }
export const fetchAlerts = (market: Market, symbol: string) =>
  j<Alert[]>(`/api/alerts?${new URLSearchParams({ market, symbol })}`);
export const createAlert = (market: Market, symbol: string, price: number, last: number, note: string) =>
  j<Alert>("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market, symbol, price, last, note }) });
export const deleteAlert = (id: number) => j<{ ok: boolean }>(`/api/alerts/${id}`, { method: "DELETE" });

export const fetchDrawings = (market: Market, symbol: string) =>
  j<Drawing[]>(`/api/drawings?${new URLSearchParams({ market, symbol })}`);

export const saveDrawings = (market: Market, symbol: string, items: Drawing[]) =>
  j<{ ok: boolean }>(`/api/drawings?${new URLSearchParams({ market, symbol })}`, put(items));

export const getState = <T,>(key: string) => j<T | null>(`/api/state/${key}`);
export const putState = (key: string, value: unknown) => j<{ ok: boolean }>(`/api/state/${key}`, put(value));

/** 加密貨幣即時 K 線；斷線自動重連。回傳關閉函式。 */
export function liveKline(symbol: string, iv: string, onBar: (b: Bar) => void): () => void {
  let ws: WebSocket | null = null, closed = false, retry = 0, timer = 0;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/kline?${new URLSearchParams({ symbol, iv })}`);
    ws.onmessage = (e) => { retry = 0; onBar(JSON.parse(e.data)); };
    ws.onclose = () => {
      if (closed) return;
      timer = window.setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => { closed = true; clearTimeout(timer); ws?.close(); };
}
