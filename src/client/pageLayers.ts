import type { PageObject } from "../shared/pageObjects";

export type PageLayerBand = "front" | "back";
export type PageLayerDropPosition = "before" | "after";
export type PageLayerStepDirection = "up" | "down";

/**
 * ページ編集のレイヤ一覧で使う表示帯。現行スキーマではコマ画像の背面へ移せるのは
 * ImageObject だけなので、それ以外は常に front として扱う。
 */
export function pageLayerBand(object: PageObject): PageLayerBand {
  return object.kind === "image" && object.band === "back" ? "back" : "front";
}

/** 書き出しデータを変えず、編集中のキャンバスだけに適用する可視性フィルター。 */
export function visiblePageObjects(
  objects: readonly PageObject[],
  hiddenObjectIds: readonly string[],
  hideNonImage: boolean
): PageObject[] {
  const hidden = new Set(hiddenObjectIds);
  return objects.filter((object) => !hidden.has(object.id) && (!hideNonImage || object.kind === "image"));
}

/**
 * 上から下へ並ぶレイヤ UI のドロップ位置を、背面から前面へ格納する PageObject[] へ変換する。
 * band をまたぐ移動は ImageObject.band の明示変更と競合するため受け付けない。
 */
export function reorderPageObjectLayer(
  objects: readonly PageObject[],
  draggedId: string,
  targetId: string,
  position: PageLayerDropPosition
): PageObject[] {
  if (draggedId === targetId) {
    return [...objects];
  }
  const dragged = objects.find((object) => object.id === draggedId);
  const target = objects.find((object) => object.id === targetId);
  if (!dragged || !target || pageLayerBand(dragged) !== pageLayerBand(target)) {
    return [...objects];
  }
  const next = [...objects];
  const draggedIndex = next.findIndex((object) => object.id === draggedId);
  const [item] = next.splice(draggedIndex, 1);
  if (!item) {
    return [...objects];
  }
  const targetIndex = next.findIndex((object) => object.id === targetId);
  // UI の before(上)はデータ配列では target の後ろ(より前面)になる。
  const insertAt = position === "before" ? targetIndex + 1 : targetIndex;
  next.splice(insertAt, 0, item);
  return next;
}

/** 同じ表示帯の隣接レイヤと入れ替える。up は前面方向、down は背面方向。 */
export function stepPageObjectLayer(
  objects: readonly PageObject[],
  objectId: string,
  direction: PageLayerStepDirection
): PageObject[] {
  const object = objects.find((item) => item.id === objectId);
  if (!object) {
    return [...objects];
  }
  const bandIds = objects.filter((item) => pageLayerBand(item) === pageLayerBand(object)).map((item) => item.id);
  const bandIndex = bandIds.indexOf(objectId);
  const neighborId = bandIds[direction === "up" ? bandIndex + 1 : bandIndex - 1];
  if (!neighborId) {
    return [...objects];
  }
  const next = [...objects];
  const objectIndex = next.findIndex((item) => item.id === objectId);
  const neighborIndex = next.findIndex((item) => item.id === neighborId);
  [next[objectIndex], next[neighborIndex]] = [next[neighborIndex]!, next[objectIndex]!];
  return next;
}
