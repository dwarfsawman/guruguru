import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import {
  clearActiveImagePan,
  closeMaskEditorSession
} from "./maskEditorController";
import { clearActiveWebSamBoxPrompt, destroyWebSamWorkerSession } from "./webSamController";
import { clearSelectedPoseEdges, closePoseEditorSession } from "./poseEditorController";
import { closePaintEditorSession } from "./paintEditorController";

export function openAssetDetail(assetId: string) {
  state.activeAssetId = assetId;
  // 編集モード（マスク/ポーズ）は常に閉じた状態で開く。マスク/ポーズの「添付」状態は
  // それぞれの enabled で独立管理し、編集モードの開閉とは切り離す。
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  clearSelectedPoseEdges();
  clearActiveImagePan();
  requestRender();
}

export function closeAssetDetail() {
  closeMaskEditorSession();
  closePaintEditorSession();
  clearActiveWebSamBoxPrompt();
  void destroyWebSamWorkerSession();
  closePoseEditorSession();
  state.activeAssetId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  requestRender();
}

registerActions({
  "asset-detail": (id) => openAssetDetail(id),
  "close-detail": () => closeAssetDetail()
});
