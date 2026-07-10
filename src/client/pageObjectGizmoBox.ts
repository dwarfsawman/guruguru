/**
 * ページオブジェクトの「ギズモ外接矩形」を作る(Docs/Feature-CGCollectionSuite.md P1/P2/P3)。
 * box/balloon は `size` をそのまま使う。text はレイアウトの bbox(`textLayoutClient.ts` のクライアント側 LRU
 * キャッシュ)を使い、未着(初回・サイズ変更直後でまだレスポンスが無い間)は仮サイズにする
 * (`Docs/Feature-CGCollectionSuite.md` P2: 「初回はプレースホルダの点線枠のみ」)。
 * `pageObjectsController.ts`(ドラッグ数学)と `pagePanelLightboxView.ts`(選択枠/ヒットエリアの描画)の
 * 両方から参照する共通ヘルパ -- 2つが互いを import し合う循環を避けるためにここへ切り出した。
 */
import { PAGE_OBJECT_MIN_SIZE, type BalloonObject, type BoxObject, type ImageObject, type TextObject } from "../shared/pageObjects";
import type { GizmoBox } from "./svgGizmo";
import { getCachedTextLayout } from "./textLayoutClient";

/** text オブジェクトのレイアウト未着時、ギズモ枠に使う仮サイズ(page 単位の正方形)。 */
export const TEXT_GIZMO_PLACEHOLDER_SIZE = 0.1;

export function gizmoBoxForPageObject(object: BoxObject | BalloonObject | TextObject | ImageObject): GizmoBox {
  if (object.kind === "box" || object.kind === "balloon" || object.kind === "image") {
    return { center: { ...object.position }, size: { ...object.size }, rotation: object.rotation };
  }
  const layout = getCachedTextLayout(object.content, object.maxWidth);
  const size = layout
    ? {
        x: Math.max(PAGE_OBJECT_MIN_SIZE, layout.bbox.maxX - layout.bbox.minX),
        y: Math.max(PAGE_OBJECT_MIN_SIZE, layout.bbox.maxY - layout.bbox.minY)
      }
    : { x: TEXT_GIZMO_PLACEHOLDER_SIZE, y: TEXT_GIZMO_PLACEHOLDER_SIZE };
  return { center: { ...object.position }, size, rotation: object.rotation };
}
