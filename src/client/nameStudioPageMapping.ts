/**
 * ネーム候補を切り替える際の読書位置対応。
 * 同じ数値のページではなく、現在ページの中央付近にあるbeat/source elementを
 * 切替先で探し、見つからない場合だけ全体の進捗率で近似する。
 */

export interface ComparableNameStudioPanel {
  sourceBeatIds?: readonly string[];
  beatIds?: readonly string[];
  sourceElementIds?: readonly string[];
}

export interface ComparableNameStudioPage {
  panels: readonly ComparableNameStudioPanel[];
}

export interface ComparableNameStudioPlan {
  pages: readonly ComparableNameStudioPage[];
}

export type NameStudioPageMappingBasis = "beat" | "element" | "progress";

export interface NameStudioPageMapping {
  pageIndex: number;
  basis: NameStudioPageMappingBasis;
  anchorId: string | null;
}

function clampPageIndex(pageCount: number, pageIndex: number): number {
  if (pageCount <= 0) return 0;
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.max(0, Math.min(pageCount - 1, Math.trunc(pageIndex)));
}

function progressPageIndex(fromCount: number, toCount: number, fromIndex: number): number {
  if (toCount <= 1) return 0;
  if (fromCount <= 1) return clampPageIndex(toCount, fromIndex);
  const progress = clampPageIndex(fromCount, fromIndex) / (fromCount - 1);
  return Math.round(progress * (toCount - 1));
}

function orderedCentralIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter(Boolean))];
  const center = (unique.length - 1) / 2;
  return unique
    .map((id, index) => ({ id, distance: Math.abs(index - center), index }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((entry) => entry.id);
}

function pageIds(page: ComparableNameStudioPage, basis: Exclude<NameStudioPageMappingBasis, "progress">): string[] {
  if (basis === "beat") {
    return page.panels.flatMap((panel) => panel.sourceBeatIds?.length ? panel.sourceBeatIds : panel.beatIds ?? []);
  }
  return page.panels.flatMap((panel) => panel.sourceElementIds ?? []);
}

function findAnchoredPage(
  plan: ComparableNameStudioPlan,
  anchorIds: readonly string[],
  basis: Exclude<NameStudioPageMappingBasis, "progress">,
  expectedIndex: number
): NameStudioPageMapping | null {
  const orderedAnchors = orderedCentralIds(anchorIds);
  const matches = plan.pages
    .map((page, pageIndex) => {
      const targetIds = new Set(pageIds(page, basis));
      const matchingAnchors = orderedAnchors.filter((anchorId) => targetIds.has(anchorId));
      return { pageIndex, matchingAnchors };
    })
    .filter((entry) => entry.matchingAnchors.length > 0)
    .sort((a, b) =>
      b.matchingAnchors.length - a.matchingAnchors.length
      || Math.abs(a.pageIndex - expectedIndex) - Math.abs(b.pageIndex - expectedIndex)
      || a.pageIndex - b.pageIndex
    );
  const best = matches[0];
  return best ? { pageIndex: best.pageIndex, basis, anchorId: best.matchingAnchors[0]! } : null;
}

/**
 * A p66→B切替のような比較で、同じ場面を含むB側ページへ移動する。
 * ページ境界が候補ごとに違っても、beat→source element→進捗率の順で対応できる。
 */
export function mapNameStudioPage(
  fromPlan: ComparableNameStudioPlan | null,
  toPlan: ComparableNameStudioPlan,
  fromPageIndex: number
): NameStudioPageMapping {
  const toCount = toPlan.pages.length;
  if (toCount === 0) return { pageIndex: 0, basis: "progress", anchorId: null };
  const fromCount = fromPlan?.pages.length ?? 0;
  const expectedIndex = progressPageIndex(fromCount, toCount, fromPageIndex);
  if (!fromPlan || fromCount === 0) {
    return { pageIndex: expectedIndex, basis: "progress", anchorId: null };
  }
  const sourcePage = fromPlan.pages[clampPageIndex(fromCount, fromPageIndex)];
  if (!sourcePage) return { pageIndex: expectedIndex, basis: "progress", anchorId: null };

  const beatMatch = findAnchoredPage(toPlan, pageIds(sourcePage, "beat"), "beat", expectedIndex);
  if (beatMatch) return beatMatch;
  const elementMatch = findAnchoredPage(toPlan, pageIds(sourcePage, "element"), "element", expectedIndex);
  return elementMatch ?? { pageIndex: expectedIndex, basis: "progress", anchorId: null };
}
