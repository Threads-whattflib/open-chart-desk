// 自家網頁共用的 Bombadil 規則（補內建預設抓不到的部分）
// 內建 noHttpErrorCodes 只看「頁面本身」的回應；fetch / XHR / 圖片的 4xx、5xx 抓不到 → failedRequests 補。
import { extract, always, actions } from "@antithesishq/bombadil";

// 每個專案自己決定哪些失敗是設計如此（例：logo 404 退色塊）。用 RegExp 比對「方法無關的 path+query」。
export function makeCommon(opts: { ignore?: RegExp[]; badText?: RegExp } = {}) {
  const ignore = opts.ignore ?? [];
  // 金融數字頁常見的壞值：NaN、undefined、Infinity、[object Object]
  const badText = opts.badText ?? /\bNaN\b|\bundefined\b|Infinity|\[object Object\]/;

  // 1) 子資源（fetch / XHR / img / script）回 >=400：Chrome 的 PerformanceResourceTiming.responseStatus
  const failed = extract((state) => {
    const perf = state.window.performance;
    return perf
      .getEntriesByType("resource")
      .map((e: any) => {
        const u = new URL(e.name);
        return { url: u.pathname + u.search, status: e.responseStatus ?? 0, same: u.origin === state.window.location.origin };
      })
      .filter((r: any) => r.same && r.status >= 400)
      .map((r: any) => `${r.status} ${r.url}`);
  });
  const failedRequests = always(() =>
    failed.current.filter((s) => !ignore.some((re) => re.test(s))).length === 0,
  );

  // 2) 畫面上出現壞值文字（只看看得到的文字，不看 script）
  const shownBad = extract((state) => {
    const t = state.document.body?.innerText ?? "";
    const m = t.match(badText);
    if (!m) return null;
    const i = m.index ?? 0;
    return t.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, " ");
  });
  const noBadValueText = always(() => shownBad.current === null);

  // 3) 網頁設計準則：不能有橫向捲動。違規時順便列出右緣超出視窗的元素（最多 3 個），直接知道是誰撐出去
  const overflowX = extract((state) => {
    const d = state.document.documentElement;
    // 跟 innerWidth 比（含捲軸寬）：headless Chrome 的捲軸占 15px，真手機是浮動捲軸不占寬，用 clientWidth 會誤報
    const w = state.window.innerWidth;
    const over = d.scrollWidth - w;
    if (over <= 1) return null;
    const culprits: string[] = [];
    for (const el of Array.from(state.document.body.querySelectorAll("*"))) {
      const r = (el as Element).getBoundingClientRect();
      if (r.right > w + 1 && r.width > 0) {
        const e = el as HTMLElement;
        const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
        culprits.push(`${e.tagName.toLowerCase()}${cls ? "." + cls : ""} right=${Math.round(r.right)}`);
        if (culprits.length >= 3) break;
      }
    }
    return { over, page: state.window.location.pathname, culprits };
  });
  const noHorizontalScroll = always(() => overflowX.current === null);

  // 4) 動作：畫面上沒有可點的東西（開機「載入中」畫面）時一直等。內建只有 waitOnce，
  //    重新整理後若抓到還沒渲染完的畫面，等一次還是沒東西點就會「Error: no actions available」提早結束
  const clickable = extract((state) =>
    state.document.querySelectorAll("button, a[href], input, select, textarea, [role=button]").length,
  );
  const waitWhileLoading = actions(() => (clickable.current === 0 ? ["Wait"] : []));

  return { failedRequests, noBadValueText, noHorizontalScroll, waitWhileLoading };
}
