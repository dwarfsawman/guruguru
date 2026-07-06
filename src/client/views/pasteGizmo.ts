/**
 * 貼り付けオブジェクトの変形ギズモ(SVG オーバーレイ)の render helper。
 * `assetModal.ts` と同様、state は引数で受け取るため controller への逆依存を持たない。
 *
 * - viewBox は画像 natural size に一致させ、座標は natural px で出力する
 *   (`pointerToMaskCanvasPoint` と同一空間。回転は SVG 属性内のみで CSS transform に入れない)。
 * - 枠線は `vector-effect: non-scaling-stroke`(pose/websam の前例)で zoom 中も線幅一定。
 * - ハンドル半径は render 後の sync(`syncPasteGizmo`)が画面基準一定サイズへ再計算する。
 * - id 付き要素は domMorph が同一ノードを維持するため、ドラッグ中の属性直接更新と両立する。
 */
import { escapeAttr } from "../format";
import type { PaintDraft } from "../paintTypes";
import { pastedObjectCorners, localToWorld } from "../pasteTransform";

/** 回転ハンドルの柄の長さ(natural px 初期値。sync が画面基準へ再計算)。 */
export const PASTE_ROTATE_STICK_NATURAL = 28;
/** ハンドルの画面基準半径(px)。sync で natural px へ換算する。 */
export const PASTE_HANDLE_SCREEN_RADIUS = 6;

export function renderPasteGizmoOverlay(draft: PaintDraft, viewWidth: number, viewHeight: number): string {
  const selected = draft.selectedPasteObjectId
    ? draft.pasteObjects.find((object) => object.id === draft.selectedPasteObjectId) ?? null
    : null;
  if (!selected || viewWidth <= 0 || viewHeight <= 0) {
    return "";
  }
  const corners = pastedObjectCorners(selected);
  const points = corners.map((corner) => `${corner.x},${corner.y}`).join(" ");
  const topMid = localToWorld(selected.transform, { x: 0, y: -selected.sourceHeight / 2 });
  const rotateHandle = rotateHandlePosition(selected, PASTE_ROTATE_STICK_NATURAL);
  const initialRadius = PASTE_HANDLE_SCREEN_RADIUS * (viewWidth / 800);
  const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"];
  return `
    <svg id="pasteGizmoOverlay" class="paste-gizmo-overlay" viewBox="0 0 ${viewWidth} ${viewHeight}" data-asset-id="${escapeAttr(draft.assetId)}" data-object-id="${escapeAttr(selected.id)}" aria-hidden="true">
      <polygon id="pasteGizmoOutline" class="paste-outline" points="${points}" />
      <line id="pasteGizmoRotateStick" class="paste-rotate-stick" x1="${topMid.x}" y1="${topMid.y}" x2="${rotateHandle.x}" y2="${rotateHandle.y}" />
      ${corners
        .map(
          (corner, index) => `
        <circle id="pasteGizmoCorner${index}" class="paste-handle paste-handle-scale" style="cursor: ${cornerCursors[index]};" data-paste-handle="scale" data-corner="${index}" cx="${corner.x}" cy="${corner.y}" r="${initialRadius}" />`
        )
        .join("")}
      <circle id="pasteGizmoRotateHandle" class="paste-handle paste-handle-rotate" data-paste-handle="rotate" cx="${rotateHandle.x}" cy="${rotateHandle.y}" r="${initialRadius}" />
    </svg>
  `;
}

/** 回転ハンドル位置(上辺中央から法線方向へ stick 分だけ外側)。sync/ジェスチャからも使う。 */
export function rotateHandlePosition(
  object: { sourceHeight: number; transform: { x: number; y: number; rotation: number; scaleX: number; scaleY: number } },
  stickNatural: number
): { x: number; y: number } {
  const halfH = object.sourceHeight / 2;
  // ローカル -Y 方向へ、スケール適用後の高さ + stick(natural px)だけ伸ばす。
  const outwardLocalY = -(halfH + stickNatural / Math.max(1e-6, object.transform.scaleY));
  return localToWorld(object.transform, { x: 0, y: outwardLocalY });
}
