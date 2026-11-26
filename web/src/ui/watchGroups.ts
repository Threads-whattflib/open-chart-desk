import { symKey, type Market, type Sym } from "../types";

/**
 * 觀察清單的自訂族群（市場底下再分，例如美股 → AI 半導體 / 記憶體）。
 * 族群只是每檔商品上的 group 名稱，不另外存：族群的先後 = 清單裡第一次出現的順序，沒設族群的放最後（未分類）。
 * 所以「改族群順序」「把商品移到某族群」都是重排整份清單。
 */
export interface Group { name: string; syms: Sym[] }

export function groupsOf(list: Sym[], market: Market): Group[] {
  const m = new Map<string, Sym[]>();
  for (const s of list) {
    if (s.market !== market) continue;
    const g = s.group || "";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(s);
  }
  const out = [...m].filter(([g]) => g).map(([name, syms]) => ({ name, syms }));
  if (m.has("")) out.push({ name: "", syms: m.get("")! });
  return out;
}

/** 畫面上的順序（市場 → 族群 → 商品）；商品膠囊滾輪也照這個。 */
export const displayOrder = (list: Sym[], markets: Market[]) =>
  markets.flatMap((mk) => groupsOf(list, mk).flatMap((g) => g.syms));

/** 把商品放進族群（空字串 = 未分類），排到該族群最後。 */
export function setGroup(list: Sym[], s: Sym, group: string): Sym[] {
  const k = symKey(s);
  const item = { ...list.find((x) => symKey(x) === k)!, group: group || undefined };
  if (!group) delete item.group;
  const rest = list.filter((x) => symKey(x) !== k);
  let at = -1;
  rest.forEach((x, i) => { if (x.market === s.market && (x.group || "") === group) at = i; });
  rest.splice(at >= 0 ? at + 1 : rest.length, 0, item);
  return rest;
}

/** 族群改名；新名字是空的 = 解散（商品變未分類）；改成已有的名字 = 合併。 */
export function renameGroup(list: Sym[], market: Market, from: string, to: string): Sym[] {
  return list.map((x) => {
    if (x.market !== market || (x.group || "") !== from) return x;
    const y = { ...x, group: to || undefined };
    if (!to) delete y.group;
    return y;
  });
}

/** 族群往上移一格：整組搬到前一個族群的第一檔前面。 */
export function groupUp(list: Sym[], market: Market, name: string): Sym[] {
  const gs = groupsOf(list, market).filter((g) => g.name);
  const i = gs.findIndex((g) => g.name === name);
  if (i <= 0) return list;
  const mine = new Set(gs[i].syms.map(symKey));
  const rest = list.filter((x) => !mine.has(symKey(x)));
  const at = rest.findIndex((x) => symKey(x) === symKey(gs[i - 1].syms[0]));
  rest.splice(at, 0, ...gs[i].syms);
  return rest;
}
