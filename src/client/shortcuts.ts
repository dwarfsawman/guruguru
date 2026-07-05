import { state } from "./appState";
import { setAssetStatus, toggleFavorite, toggleSelect } from "./generationController";
import { findAsset } from "./assetLookup";
import { fillGenerationFormFromAsset } from "./generationDraft";

/**
 * アセット詳細表示中のキーボードショートカット(r=却下 / f=お気に入り / space=選択 / Enter=img2imgへ)。
 * 呼び出し元(main.ts)で `state.activeAssetId` 有無・テキスト入力中でないことを確認済みの前提。
 */
export function handleAssetActionShortcuts(event: KeyboardEvent) {
  if (!state.activeAssetId) {
    return;
  }
  if (event.key === "r" || event.key === "R") {
    void setAssetStatus(state.activeAssetId, "rejected");
  }
  if (event.key === "f" || event.key === "F") {
    void toggleFavorite(state.activeAssetId);
  }
  if (event.key === " ") {
    event.preventDefault();
    void toggleSelect(state.activeAssetId);
  }
  if (event.key === "Enter") {
    const asset = findAsset(state.activeAssetId);
    if (asset) {
      fillGenerationFormFromAsset(asset, "img2img");
    }
  }
}
