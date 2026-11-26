// build 前把 cryptocurrency-icons（CC0 授權）的彩色 SVG 複製到 public/coins/，前端用 /coins/<代號小寫>.svg 取圖。
// public/coins 不進 git；沒有圖的幣（例如新上市的）前端會退回色塊加文字。
import { cpSync, existsSync, mkdirSync } from "node:fs";
const src = new URL("../node_modules/cryptocurrency-icons/svg/color/", import.meta.url);
const dst = new URL("../public/coins/", import.meta.url);
if (!existsSync(src)) { console.error("找不到 cryptocurrency-icons，先跑 npm ci"); process.exit(1); }
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
