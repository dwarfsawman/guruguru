/**
 * 実装は shared/pageLayoutSvg.ts へ移動(ネームv4 D3: プラン候補ワイヤーフレームを
 * サーバ/クライアントで共有するため)。既存の client import を変えないための再エクスポート。
 */
export {
  num,
  panelShapeElement,
  renderPageLayoutSvg,
  renderPageWireframeSvg,
  shapeCenter,
  type PageLayoutSvgOptions,
  type PageWireframeOptions,
  type WireframePanelInfo
} from "../../shared/pageLayoutSvg";
