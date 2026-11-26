// 技術指標計算：全部回傳跟 K 棒等長的陣列，前面不足的位置是 null
export type Series = (number | null)[];

export function sma(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export function bollinger(v: number[], n: number, k: number): { mid: Series; up: Series; lo: Series } {
  const mid = sma(v, n);
  const up: Series = new Array(v.length).fill(null), lo: Series = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    const m = mid[i] as number;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = m + k * sd; lo[i] = m - k * sd;
  }
  return { mid, up, lo };
}

// RSI（Wilder 平滑，跟 TradingView 內建同一算法）
export function rsi(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function macd(v: number[], fast: number, slow: number, signal: number) {
  const f = ema(v, fast), s = ema(v, slow);
  const line: Series = v.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  const start = line.findIndex((x) => x != null);
  const sig: Series = new Array(v.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start) as number[], signal);
    for (let i = 0; i < e.length; i++) sig[start + i] = e[i];
  }
  const hist: Series = v.map((_, i) => (line[i] != null && sig[i] != null ? (line[i] as number) - (sig[i] as number) : null));
  return { line, sig, hist };
}
