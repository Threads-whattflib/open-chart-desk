// Random-click test spec for Bombadil (https://github.com/antithesishq/bombadil). See README "Random-click test".
// Built-in defaults + common.ts (sub-request 4xx/5xx, NaN/undefined text, horizontal scroll, wait on boot screen).
export * from "@antithesishq/bombadil/browser/defaults";
import { makeCommon } from "./common.ts";

export const { failedRequests, noBadValueText, noHorizontalScroll, waitWhileLoading } = makeCommon({
  ignore: [
    /^404 \/api\/logo\?/,   // 查不到 logo 回 404，前端 icons.tsx 依序退回內建 /coins 圖示／色塊
  ],
});
