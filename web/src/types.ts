export type Market = "crypto" | "tw" | "us";

export interface Sym { market: Market; symbol: string; name: string; exch: string; group?: string }   // group = 觀察清單裡的自訂族群
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

// 畫圖工具種類：趨勢線、射線、延伸線、水平線、水平射線、垂直線、矩形、平行通道、Fib 回撤、文字、量尺、多單、空單、
// FRVP、價格範圍、日期範圍、向上 / 向下箭頭、價格標籤、Fib 延伸（三點）
export type Kind = "trend" | "ray" | "ext" | "hline" | "hray" | "vline" | "rect" | "channel" | "fib" | "text"
  | "measure" | "long" | "short" | "frvp" | "prange" | "drange" | "arrowup" | "arrowdown" | "plabel" | "fibext";
export type Tool = "cursor" | Kind;

export interface Pt { t: number; p: number }   // t = UTC 秒（不存 K 棒索引，換週期才對得上）

export interface Drawing {
  id: string;
  kind: Kind;
  pts: Pt[];
  color: string;
  width: number;
  dash: number;        // 0 實線、1 虛線、2 點線
  text?: string;
  locked?: boolean;
  levels?: number[];   // Fib 要畫的層級
  // 各工具自己的選項。Fib：trend 畫趨勢線、bg 背景、price 標籤帶價格；
  // FRVP：rows 行數、va 數值區 %、extend 向右延伸、width 寬度（範圍的 %）、vah / val / poc 三條線
  opts?: Record<string, number | boolean>;
  // 設定頁（照 TradingView）：名稱、不透明度、線上文字的顏色、哪些週期不顯示
  name?: string;
  opacity?: number;      // 0~1，預設 1
  textColor?: string;    // 線上文字顏色（預設跟線同色）；文字大小 / 位置在 opts.tsz / tal / tvp
  hideOn?: string[];     // 不顯示的週期組：m 分、h 時、d 日、w 週、M 月
}

/** 畫圖模板（每種工具各自一組，存在設定裡，電腦手機共用）。 */
export interface DrawTpl { name: string; s: Partial<Drawing> }

/** 週期 → 可見性分組（1m/15m → m、1h/4h → h、1d → d、1w → w、1M → M）。 */
export const ivGroup = (iv: string) => iv.slice(-1);

export interface Settings {
  ma: { on: boolean; type: "SMA" | "EMA"; periods: number[] };
  bb: { on: boolean; n: number; k: number };
  rsi: { on: boolean; n: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
  vol: boolean;
  log: boolean;
  autoScale: boolean;    // 價格軸自動調整高度（座標軸右下的 A 鈕）；關掉時高度固定，可以上下拖
  magnet: boolean;
  watchOpen: boolean;
  favTools: Kind[];      // 手機：繪圖頁打星號的工具
  showFav: boolean;      // 手機：在圖表上顯示收藏的工具列
  favIvs: string[];      // 手機：收藏的週期
  watchTab: string;      // 手機：觀察清單分頁（all / crypto / tw / us），商品膠囊滾輪也只滾這一頁
  chartType: "candle" | "line";   // K 線 / 折線（電腦、手機共用）
  toolLast: Record<string, Kind>; // 電腦：左側工具列每一組上次用的工具（照 TradingView）
  deskFav: boolean;      // 電腦：圖上顯示收藏工具列（可拖動）
  favPos?: { x: number; y: number };     // 電腦：收藏工具列位置（圖表區內的 px）
  propsPos?: { x: number; y: number };   // 電腦：圖形浮動工具列位置
  detailOpen: boolean;   // 電腦：觀察清單下方的商品詳情
  drawTpl?: Record<string, DrawTpl[]>;   // 畫圖模板，key = 工具種類
  last?: { sym: Sym; iv: string };
}

export const DEFAULT_SETTINGS: Settings = {
  ma: { on: true, type: "SMA", periods: [20, 60] },
  bb: { on: false, n: 20, k: 2 },
  rsi: { on: false, n: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
  vol: true,
  log: false,
  autoScale: false,
  magnet: false,
  watchOpen: true,
  favTools: ["trend", "hline", "ray", "fib", "frvp", "long", "short"],
  showFav: false,
  favIvs: ["15m", "1h", "4h", "1d", "1w"],
  watchTab: "all",
  chartType: "candle",
  toolLast: {},
  deskFav: false,
  detailOpen: true,
};

// 第一次打開時的觀察清單（按市場分頁、族群照第一次出現的順序）；之後的增刪存在伺服器 data/watchlist.json
export const DEFAULT_WATCH: Sym[] = [
  { market: "crypto", symbol: "BTCUSDT", name: "BTC / USDT", exch: "Binance", group: "主流幣" },
  { market: "crypto", symbol: "ETHUSDT", name: "ETH / USDT", exch: "Binance", group: "主流幣" },
  { market: "crypto", symbol: "SOLUSDT", name: "SOL / USDT", exch: "Binance", group: "主流幣" },
  { market: "crypto", symbol: "BNBUSDT", name: "BNB / USDT", exch: "Binance", group: "主流幣" },
  { market: "crypto", symbol: "XRPUSDT", name: "XRP / USDT", exch: "Binance", group: "主流幣" },
  { market: "crypto", symbol: "HYPEUSDT", name: "HYPE / USDT", exch: "Binance", group: "DeFi / RWA" },
  { market: "crypto", symbol: "ONDOUSDT", name: "ONDO / USDT", exch: "Binance", group: "DeFi / RWA" },
  { market: "crypto", symbol: "ETHBTC", name: "以太坊 / 比特幣", exch: "Binance", group: "比值" },
  { market: "tw", symbol: "2330", name: "台積電", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "2454", name: "聯發科", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "3034", name: "聯詠", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "2379", name: "瑞昱", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "3661", name: "世芯-KY", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "3443", name: "創意", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "3035", name: "智原", exch: "上市", group: "晶圓 / IC 設計" },
  { market: "tw", symbol: "2317", name: "鴻海", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "2382", name: "廣達", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "3231", name: "緯創", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "6669", name: "緯穎", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "2376", name: "技嘉", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "3017", name: "奇鋐", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "2345", name: "智邦", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "2308", name: "台達電", exch: "上市", group: "AI 伺服器 / 散熱 / 網通" },
  { market: "tw", symbol: "8299", name: "群聯", exch: "上櫃", group: "記憶體" },
  { market: "tw", symbol: "2408", name: "南亞科", exch: "上市", group: "記憶體" },
  { market: "tw", symbol: "2344", name: "華邦電", exch: "上市", group: "記憶體" },
  { market: "tw", symbol: "0050", name: "元大台灣50", exch: "上市", group: "ETF" },
  { market: "tw", symbol: "00631L", name: "元大台灣50正2", exch: "上市", group: "ETF" },
  { market: "tw", symbol: "00981A", name: "主動統一台股增長", exch: "上市", group: "ETF" },
  { market: "tw", symbol: "00403A", name: "主動統一升級50", exch: "上市", group: "ETF" },
  { market: "us", symbol: "AAPL", name: "Apple Inc.", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "MSFT", name: "Microsoft", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "GOOG", name: "Alphabet (Google)", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "AMZN", name: "Amazon.com", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "META", name: "Meta Platforms", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "NFLX", name: "Netflix, Inc.", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "TSLA", name: "Tesla", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "PLTR", name: "Palantir Technologies", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "SPCX", name: "Space Exploration Technologies", exch: "NASDAQ", group: "大型科技" },
  { market: "us", symbol: "NVDA", name: "NVIDIA", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "AMD", name: "Advanced Micro Devices, Inc.", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "AVGO", name: "Broadcom Inc.", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "ARM", name: "Arm Holdings plc", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "TSM", name: "Taiwan Semiconductor Manufactur", exch: "NYSE", group: "AI 半導體" },
  { market: "us", symbol: "ASML", name: "ASML Holding N.V. - New York Re", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "MRVL", name: "Marvell Technology, Inc.", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "CDNS", name: "Cadence Design Systems", exch: "US", group: "AI 半導體" },
  { market: "us", symbol: "SNPS", name: "Synopsys, Inc.", exch: "NASDAQ", group: "AI 半導體" },
  { market: "us", symbol: "MU", name: "Micron Technology, Inc.", exch: "NASDAQ", group: "記憶體" },
  { market: "us", symbol: "SNDK", name: "Sandisk", exch: "NASDAQ", group: "記憶體" },
  { market: "us", symbol: "DRAM", name: "Roundhill Memory ETF", exch: "NYSE", group: "記憶體" },
  { market: "us", symbol: "CRWV", name: "CoreWeave, Inc.", exch: "NASDAQ", group: "AI 基建 / 電力" },
  { market: "us", symbol: "DELL", name: "Dell Technologies Inc.", exch: "NYSE", group: "AI 基建 / 電力" },
  { market: "us", symbol: "NOK", name: "Nokia Corporation Sponsored", exch: "NYSE", group: "AI 基建 / 電力" },
  { market: "us", symbol: "VST", name: "Vistra Corp.", exch: "NYSE", group: "AI 基建 / 電力" },
  { market: "us", symbol: "GEV", name: "GE Vernova Inc.", exch: "NYSE", group: "AI 基建 / 電力" },
  { market: "us", symbol: "BE", name: "Bloom Energy Corporation", exch: "NYSE", group: "AI 基建 / 電力" },
  { market: "us", symbol: "ORCL", name: "Oracle Corporation", exch: "NYSE", group: "軟體 / 資安" },
  { market: "us", symbol: "NOW", name: "ServiceNow, Inc.", exch: "NYSE", group: "軟體 / 資安" },
  { market: "us", symbol: "ADBE", name: "Adobe Inc.", exch: "NASDAQ", group: "軟體 / 資安" },
  { market: "us", symbol: "CRWD", name: "CrowdStrike Holdings, Inc.", exch: "NASDAQ", group: "軟體 / 資安" },
  { market: "us", symbol: "SNOW", name: "Snowflake Inc.", exch: "NYSE", group: "軟體 / 資安" },
  { market: "us", symbol: "MSTR", name: "Strategy Inc Class A", exch: "NASDAQ", group: "加密概念" },
  { market: "us", symbol: "COIN", name: "Coinbase Global", exch: "NASDAQ", group: "加密概念" },
  { market: "us", symbol: "HOOD", name: "Robinhood Markets", exch: "NASDAQ", group: "加密概念" },
  { market: "us", symbol: "CRCL", name: "Circle Internet Group", exch: "NYSE", group: "加密概念" },
  { market: "us", symbol: "SECZ", name: "Securitize Corp.", exch: "NYSE", group: "加密概念" },
  { market: "us", symbol: "COST", name: "Costco Wholesale Corporation", exch: "NASDAQ", group: "消費" },
  { market: "us", symbol: "MCD", name: "McDonald's Corporation", exch: "NYSE", group: "消費" },
  { market: "us", symbol: "SPY", name: "State Street SPDR S&P 500 ETF T", exch: "NYSEArca", group: "ETF" },
  { market: "us", symbol: "QQQ", name: "Invesco QQQ Trust", exch: "NASDAQ", group: "ETF" },
  { market: "us", symbol: "SOXX", name: "iShares Semiconductor ETF", exch: "NASDAQ", group: "ETF" },
  { market: "us", symbol: "SOXL", name: "Direxion Daily Semiconductor Bu", exch: "NYSEArca", group: "ETF" },
  { market: "us", symbol: "IGV", name: "iShares Expanded Tech-Software ETF", exch: "NYSE", group: "ETF" },
  { market: "us", symbol: "^VIX", name: "CBOE Volatility Index", exch: "CXI", group: "指數 / 商品" },
  { market: "us", symbol: "DX-Y.NYB", name: "ICE US Dollar Index - Index - C", exch: "ICE Futures", group: "指數 / 商品" },
  { market: "us", symbol: "^KS11", name: "韓國綜合股價指數", exch: "KRX", group: "指數 / 商品" },
  { market: "us", symbol: "GC=F", name: "黃金期貨", exch: "COMEX", group: "指數 / 商品" },
  { market: "us", symbol: "CL=F", name: "輕原油期貨", exch: "NYMEX", group: "指數 / 商品" },
];

export const IV_SEC: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
  "1d": 86400, "1w": 604800, "1M": 2592000,
};
export const IV_LABEL: Record<string, string> = {
  "1m": "1分", "3m": "3分", "5m": "5分", "15m": "15分", "30m": "30分", "1h": "1時", "2h": "2時", "4h": "4時",
  "1d": "日", "1w": "週", "1M": "月",
};
// 手機版照 TradingView 的寫法：15m、1H、1D
export const IV_SHORT: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H",
  "1d": "1D", "1w": "1W", "1M": "1M",
};
export const MARKET_LABEL: Record<Market, string> = { crypto: "加密", tw: "台股", us: "美股" };

export const symKey = (s: { market: string; symbol: string }) => `${s.market}:${s.symbol}`;
