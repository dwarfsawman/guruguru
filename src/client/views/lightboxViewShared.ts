/**
 * ページ編集 lightbox の各モードビュー(pagePanelLightboxView.ts から分割)が共有する定数・ヘルパ。
 * scale(${VIEWBOX_SCALE}) の正規化座標規約、コマ形状 clipPath、クロップ画像矩形/回転 transform など、
 * 「コマ」モードと「オブジェクト」モードの両方が同じ描画結果を出すための共通部品を置く。
 */
import type { PagePanelAssignment } from "../../shared/apiTypes";
import type { LayoutPanel, PanelCrop } from "../../shared/pageLayout";
import { panelImageRect } from "../../shared/pageLayout";
import { num, panelShapeElement } from "./pageLayoutSvg";

export const VIEWBOX_SCALE = 1000;

/** ギズモのハンドル半径 / 回転ハンドルの柄長さ(正規化座標の初期値。sync が画面基準へ再計算)。 */
export const GIZMO_HANDLE_RADIUS = 0.014;
export const GIZMO_ROTATE_STICK = 0.07;

/** レイヤパネルの可視性は編集セッションだけの状態で、PageObject/書き出しデータへは保存しない。 */
export interface PageLayerViewState {
  hiddenObjectIds: string[];
  hiddenPanelIds: string[];
  hideNonImage: boolean;
}

export function panelClipId(panelId: string): string {
  return `page-panel-clip-${panelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function renderPanelClipPath(panel: LayoutPanel): string {
  return `<clipPath id="${panelClipId(panel.id)}">${panelShapeElement(panel.shape)}</clipPath>`;
}

/**
 * 割り当て画像の `<image>` x/y/width/height。共有の `panelImageRect`(等倍・引き伸ばしなし)へ
 * 一本化する。画像がコマを覆えない部分は紙面(白)が見え、人間がクロップ編集で解消する。
 */
export function imageRectForCrop(
  bounds: [number, number, number, number],
  crop: PanelCrop,
  assignment: Pick<PagePanelAssignment, "assetWidth" | "assetHeight">
) {
  return panelImageRect(bounds, crop, assignment.assetWidth, assignment.assetHeight);
}

/** パネル外接矩形の中心(回転の軸・ギズモの基準)。 */
export function boxCenter(bounds: [number, number, number, number]): [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

/**
 * `crop.rotation` を `<image>` の rotate transform 文字列へ(窓中心=外接矩形中心まわりに回す)。
 * 無回転なら空文字を返し、従来と同一の出力にする。回転は clip を持つ要素と**別の要素**に付ける
 * こと(同一要素だと clip も一緒に回るため)。
 */
export function rotationTransformAttr(crop: PanelCrop, center: [number, number]): string {
  const rotation = crop.rotation ?? 0;
  if (!rotation) {
    return "";
  }
  const deg = (rotation * 180) / Math.PI;
  return ` transform="rotate(${num(deg)} ${num(center[0])} ${num(center[1])})"`;
}
