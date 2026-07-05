import type {
  Asset,
  AssetParent,
  ProjectDetail
} from "../shared/apiTypes";
import {
  iconClose,
  iconDiagram,
  iconMenu
} from "./icons";
import { escapeAttr, escapeHtml, formatNumber, formatSliderValue } from "./format";
import {
  renderWorkflowDiagramCanvases,
  renderWorkflowDiagramModal,
  renderWorkflowImportModal
} from "./workflowUi";
import { renderHome, type ConnectionState, type ConnectionSummary } from "./views/homeView";
import { renderIterationTracker } from "./views/iterationTree";
import { drawIterationEdges } from "./views/iterationTreeEdges";
import { renderProjectDetail, renderSourceUploadButton } from "./views/galleryView";
import { renderGenerationPanel } from "./views/generationPanel";
import { renderAssetModal, type MaskGenerationParams } from "./views/assetModal";
import {
  setRenderCallback,
  state,
  toggleSidebarCollapsed,
  type GenerationDraftField,
  type RenderOptions
} from "./appState";
import { actionHandlerFor, bindRegisteredEvents } from "./actionRegistry";
import { inpaintDraftForAsset, persistProjectDraft } from "./draftStore";
import { assetDimension, findAsset } from "./assetLookup";
import {
  cancelPendingMaskStrokeFlush,
  handleMaskEditorPointerCancel,
  handleMaskEditorPointerDown,
  handleMaskEditorPointerMove,
  handleMaskEditorPointerUp,
  handleMaskStrokePointerCancel,
  handleMaskStrokePointerMove,
  handleMaskStrokePointerUp,
  handleMaskStrokeStartPointerDown,
  handleMaskWheelZoom,
  invalidateMaskBrushCursorCache,
  syncAssetModalMaskCanvas,
  updateInpaintDraftFromControl
} from "./maskEditorController";
import {
  handleWebSamPointerCancel,
  handleWebSamPointerMove,
  handleWebSamPointerUp,
  updateSmartMaskDraftFromControl
} from "./webSamController";
import { delay } from "./clientUtils";
import {
  getSelectedPoseEdges,
  handlePoseEditorKeydown,
  handlePoseEditorPointerCancel,
  handlePoseEditorPointerDown,
  handlePoseEditorPointerMove,
  handlePoseEditorPointerUp,
  poseDraftForAsset,
  updatePoseDraftFromControl
} from "./poseEditorController";
import { defaultPaintDraft } from "./paintDraft";
import {
  handlePaintEditorBlur,
  handlePaintEditorKeydown,
  handlePaintEditorKeyup,
  handlePaintEditorPointerCancel,
  handlePaintEditorPointerDown,
  handlePaintEditorPointerMove,
  handlePaintEditorPointerUp,
  handlePaintWheelZoom,
  paintDraftForAsset,
  setPaintBrushSize,
  setPaintColor,
  syncAssetModalPaintCanvas
} from "./paintEditorController";
import { setFormValue } from "./formUtils";
import {
  assetPassesFilter,
  captureGenerationDraft,
  currentBatchSizeValue,
  currentCfgValue,
  currentDenoiseValue,
  currentHeightValue,
  currentPositivePromptValue,
  currentSamplerValue,
  currentSchedulerValue,
  currentSeedModeValue,
  currentSeedValue,
  currentStepsValue,
  currentWidthValue,
  fillGenerationFormFromAsset,
  getActiveRound,
  getActiveRoundAssets,
  getPreferredParentAsset,
  setGenerationDraftValue,
  setGenerationSliderDraft,
  setPositivePromptDraft,
  syncPreviewPromptControl,
  updateDenoiseControlForMode
} from "./generationDraft";
import {
  handleAssetCardClick,
  handleAssetCardDblClick,
  handleIterationDotClick,
  handleIterationDotDblClick,
  isRoundActive,
  selectAllActiveRound
} from "./generationController";
import {
  captureWorkflowImportDraftFromElement,
  closeWorkflowModals,
  handleWorkflowDiagramPointerCancel,
  handleWorkflowDiagramPointerDown,
  handleWorkflowDiagramPointerMove,
  handleWorkflowDiagramPointerUp,
  handleWorkflowDiagramWheel,
  loadHome,
  loadWorkflowFile,
  refreshWorkflowImportPreview,
  uploadSourceAsset
} from "./projectController";
import { closeAssetDetail } from "./assetDetailController";
import { handleAssetActionShortcuts } from "./shortcuts";

const app = document.querySelector<HTMLDivElement>("#app")!;

setRenderCallback(render);
void boot();

async function boot() {
  await loadHome();
  bindEvents();
}

function bindEvents() {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("preview-modal")) {
      captureGenerationDraft();
      closeAssetDetail();
      return;
    }
    if (target.classList.contains("workflow-modal")) {
      closeWorkflowModals();
      return;
    }

    if (handleIterationDotClick(event)) {
      return;
    }
    if (handleAssetCardClick(event)) {
      return;
    }

    const actionTarget = target.closest<HTMLElement>("[data-action]");
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action!;
    if (action !== "reset-generation-params") {
      captureGenerationDraft();
    }
    const id = actionTarget.dataset.id ?? "";
    void handleAction(action, id, actionTarget);
  });

  app.addEventListener("dblclick", (event) => {
    if (handleAssetCardDblClick(event)) {
      return;
    }
    handleIterationDotDblClick(event);
  });

  app.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.sourceUpload) {
      void uploadSourceAsset(target).catch((error) => {
        state.busy = false;
        state.message = error instanceof Error ? error.message : String(error);
        render();
      });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.fileTarget) {
      void loadWorkflowFile(target);
      return;
    }
    if (target.closest("#template-form")) {
      captureWorkflowImportDraftFromElement(target);
      refreshWorkflowImportPreview();
      return;
    }
    if (target.id === "round-filter") {
      state.filter = target.value as typeof state.filter;
      render();
      return;
    }
    if (target.id === "grid-cols") {
      state.gridCols = Number(target.value) as typeof state.gridCols;
      render();
      return;
    }
    if (target.name === "generationMode") {
      updateDenoiseControlForMode(target.value);
    }
    if (target.dataset.smartMaskField) {
      updateSmartMaskDraftFromControl(target);
      return;
    }
    if (target.dataset.poseField) {
      updatePoseDraftFromControl(target, { commit: true });
      return;
    }
    if (target.dataset.inpaintField) {
      updateInpaintDraftFromControl(target);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.paintColorPicker) {
      setPaintColor(target.value);
      return;
    }
    if (target.dataset.generationField && target.dataset.generationField !== "prompt" && target.dataset.generationField !== "batchSize") {
      const field = target.dataset.generationField as GenerationDraftField;
      setGenerationDraftValue(field, target.value);
      const form = document.querySelector<HTMLFormElement>("#generation-form");
      if (form) {
        setFormValue(form, field, target.value);
      }
      return;
    }
    if (target.closest("#generation-form")) {
      captureGenerationDraft();
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const valueId = target instanceof HTMLInputElement ? target.dataset.valueTarget : undefined;
    if (target.dataset.generationField === "prompt") {
      setPositivePromptDraft(target.value);
      return;
    }
    if (
      target.dataset.generationField &&
      target.dataset.generationField !== "prompt" &&
      target instanceof HTMLInputElement
    ) {
      setGenerationSliderDraft(target.dataset.generationField as GenerationDraftField, target);
    }
    if (target.dataset.inpaintField) {
      updateInpaintDraftFromControl(target);
    }
    if (target.dataset.paintField === "brushSize" && target instanceof HTMLInputElement) {
      setPaintBrushSize(Number(target.value));
    }
    if (target.closest("#template-form")) {
      captureWorkflowImportDraftFromElement(target);
      refreshWorkflowImportPreview();
      return;
    }
    if (!valueId) {
      if (target.closest("#generation-form")) {
        captureGenerationDraft();
        if (target.name === "prompt") {
          syncPreviewPromptControl(target.value);
        }
      }
      return;
    }
    const valueTarget = document.getElementById(valueId);
    if (valueTarget && target instanceof HTMLInputElement) {
      const suffix =
        target.dataset.inpaintField === "onlyMaskedPadding" ||
        target.dataset.inpaintField === "featherRadius" ||
        target.dataset.inpaintField === "brushSize" ||
        target.dataset.paintField === "brushSize"
          ? "px"
          : "";
      valueTarget.textContent = `${formatSliderValue(target)}${suffix}`;
    }
    if (target.closest("#generation-form")) {
      captureGenerationDraft();
    }
    if (target.dataset.smartMaskField) {
      updateSmartMaskDraftFromControl(target);
      return;
    }
    if (target.dataset.poseField) {
      updatePoseDraftFromControl(target);
      return;
    }
  });

  app.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "maskCanvas") {
      event.preventDefault();
    }
  });

  app.addEventListener("auxclick", (event) => {
    const target = event.target as HTMLElement;
    if (event.button === 1 && target.closest(".preview-media")) {
      event.preventDefault();
    }
  });

  // イテレーションツリーのエッジ hover ポップアウトを、
  // トラッカーの overflow でクリップされないよう viewport 基準（position: fixed）で配置する。
  app.addEventListener("mouseover", (event) => {
    const edge = (event.target as HTMLElement | null)?.closest<HTMLElement>(".iteration-edge");
    if (edge) {
      positionIterationEdgePopout(edge);
    }
  });

  app.addEventListener("wheel", (event) => {
    if (handleWorkflowDiagramWheel(event)) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.id !== "maskCanvas" && target.id !== "paintCanvas" && !target.closest(".preview-media")) {
      return;
    }
    if (!state.activeAssetId) {
      return;
    }
    event.preventDefault();
    if (state.paintEditMode) {
      handlePaintWheelZoom(event);
    } else {
      handleMaskWheelZoom(event);
    }
  }, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (!state.detail) {
      if (event.key === "Escape" && state.sidebarOpen) {
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if (event.key === "Escape") {
      if (state.deletePreviewRoundId) {
        state.deletePreviewRoundId = null;
        render();
      } else if (state.activeAssetId) {
        captureGenerationDraft();
        closeAssetDetail();
      } else if (state.sidebarOpen) {
        captureGenerationDraft();
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if (isTextEntryTarget(event.target)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      void selectAllActiveRound();
      return;
    }

    if (!state.activeAssetId) {
      return;
    }

    if (handlePaintEditorKeydown(event)) {
      return;
    }

    if (handlePoseEditorKeydown(event)) {
      return;
    }

    handleAssetActionShortcuts(event);
  });

  window.addEventListener("keyup", (event) => {
    handlePaintEditorKeyup(event);
  });

  window.addEventListener("blur", () => {
    handlePaintEditorBlur();
  });

  app.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    closeOpenActionDropdowns(target);
    if (handlePoseEditorPointerDown(event)) {
      return;
    }
    if (handleMaskEditorPointerDown(event)) {
      return;
    }
    if (handleWorkflowDiagramPointerDown(event)) {
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (handlePaintEditorPointerDown(event, target)) {
      return;
    }
    handleMaskStrokeStartPointerDown(event);
  });

  app.addEventListener("pointermove", (event) => {
    if (handleMaskEditorPointerMove(event)) {
      return;
    }
    if (handleWorkflowDiagramPointerMove(event)) {
      return;
    }
    if (handleWebSamPointerMove(event)) {
      return;
    }
    if (handlePoseEditorPointerMove(event)) {
      return;
    }
    if (handlePaintEditorPointerMove(event)) {
      return;
    }
    handleMaskStrokePointerMove(event);
  });

  app.addEventListener("pointerup", (event) => {
    if (handleMaskEditorPointerUp(event)) {
      return;
    }
    if (handleWorkflowDiagramPointerUp(event)) {
      return;
    }
    if (handleWebSamPointerUp(event)) {
      return;
    }
    if (handlePoseEditorPointerUp(event)) {
      return;
    }
    if (handlePaintEditorPointerUp(event)) {
      return;
    }
    handleMaskStrokePointerUp(event);
  });

  app.addEventListener("pointercancel", (event) => {
    if (handleMaskEditorPointerCancel(event)) {
      return;
    }
    if (handleWorkflowDiagramPointerCancel(event)) {
      return;
    }
    if (handleWebSamPointerCancel(event)) {
      return;
    }
    if (handlePoseEditorPointerCancel(event)) {
      return;
    }
    if (handlePaintEditorPointerCancel(event)) {
      return;
    }
    handleMaskStrokePointerCancel(event);
  });

  bindRegisteredEvents(app);
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable || !!target.closest("[contenteditable=''], [contenteditable='true']");
}

function closeOpenActionDropdowns(exceptTarget?: EventTarget | null) {
  const exceptNode = exceptTarget instanceof Node ? exceptTarget : null;
  document.querySelectorAll<HTMLDetailsElement>(".template-export-dropdown[open], .workflow-dropdown[open]").forEach((dropdown) => {
    if (exceptNode && dropdown.contains(exceptNode)) {
      return;
    }
    dropdown.open = false;
  });
}

async function handleAction(action: string, id: string, target: HTMLElement) {
  const closesActionDropdowns = target.closest(".template-export-dropdown, .workflow-dropdown") !== null;
  try {
    const registered = actionHandlerFor(action);
    if (registered) {
      await registered(id, target);
    } else if (action === "toggle-sidebar") {
      state.sidebarOpen = !state.sidebarOpen;
      render();
    } else if (action === "toggle-sidebar-collapse") {
      toggleSidebarCollapsed();
      render();
    } else if (action === "dismiss-message") {
      state.message = "";
      render();
    } else if (action === "toggle-mask-grid-tag") {
      state.showMaskGridTag = !state.showMaskGridTag;
      render();
    } else if (action === "copy-seed") {
      const seedText = target.dataset.seed ?? "";
      if (seedText) {
        try {
          await navigator.clipboard.writeText(seedText);
        } catch {
          state.message = "クリップボードへのコピーに失敗しました。";
          render();
          return;
        }
        state.copiedSeedAssetId = id;
        render();
        await delay(1500);
        if (state.copiedSeedAssetId === id) {
          state.copiedSeedAssetId = null;
          render();
        }
      }
    }
  } catch (error) {
    state.busy = false;
    state.message = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    if (closesActionDropdowns) {
      closeOpenActionDropdowns();
    }
  }
}

function render(options: RenderOptions = {}) {
  const preserveIterationScroll = options.preserveIterationScroll ?? true;
  if (preserveIterationScroll) {
    captureIterationScrollPosition();
  } else {
    state.iterationScroll = null;
  }
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
  app.innerHTML = `
    ${renderHeader()}
    ${state.message ? `<div class="message"><pre class="message-text">${escapeHtml(state.message)}</pre><button class="message-close" type="button" data-action="dismiss-message" aria-label="メッセージを閉じる" title="閉じる">${iconClose()}</button></div>` : ""}
    ${state.detail ? renderProjectDetailView(state.detail) : renderHome(
      state.projects,
      state.settings,
      state.templates,
      state.llmSettings,
      { state: state.comfyConnection, text: state.comfyStatusText } satisfies ConnectionSummary,
      { state: state.llmConnection, text: state.llmStatusText } satisfies ConnectionSummary
    )}
    ${renderAssetModalView()}
    ${renderWorkflowImportModal(state.workflowImportModalOpen, state.workflowImportDraft)}
    ${renderWorkflowDiagramModal(state.templates, state.activeWorkflowDiagramTemplateId)}
  `;
  invalidateMaskBrushCursorCache();
  restoreIterationScrollPosition();
  if (preserveIterationScroll) {
    requestAnimationFrame(() => {
      restoreIterationScrollPosition();
    });
  }
  refreshIterationEdges();
  syncAssetModalMaskCanvas();
  syncAssetModalPaintCanvas();
  void renderWorkflowDiagramCanvases();
}

function positionIterationEdgePopout(edge: HTMLElement) {
  const popout = edge.querySelector<HTMLElement>(".iteration-edge-popout");
  if (!popout) {
    return;
  }
  const margin = 8;
  const edgeRect = edge.getBoundingClientRect();
  // visibility:hidden 要素でもレイアウトは行われるため offsetWidth/Height は有効。
  const width = popout.offsetWidth;
  const height = popout.offsetHeight;
  let left = edgeRect.left + edgeRect.width / 2 - width / 2;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
  // 既定はエッジの下、下側に収まらなければ上に反転する。
  let top = edgeRect.bottom + margin;
  if (top + height + margin > window.innerHeight) {
    top = edgeRect.top - height - margin;
  }
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
  popout.style.left = `${Math.round(left)}px`;
  popout.style.top = `${Math.round(top)}px`;
}

function captureIterationScrollPosition() {
  const tracker = document.querySelector<HTMLElement>(".iteration-tracker");
  if (!tracker) {
    return;
  }
  state.iterationScroll = {
    left: tracker.scrollLeft,
    top: tracker.scrollTop
  };
}

function restoreIterationScrollPosition() {
  const tracker = document.querySelector<HTMLElement>(".iteration-tracker");
  if (!tracker || !state.iterationScroll) {
    return;
  }
  tracker.scrollLeft = state.iterationScroll.left;
  tracker.scrollTop = state.iterationScroll.top;
}

let iterationEdgeObserver: ResizeObserver | null = null;

/**
 * イテレーションツリーのエッジ（SVG オーバーレイ）を、現在描画されている
 * `.iteration-forest` に合わせて引き直す。レイアウト確定後に測定したいので rAF 経由。
 * ノードのリフロー（container query での行/列切替やウィンドウリサイズ）に追従するよう
 * ResizeObserver でも再描画する。
 */
function refreshIterationEdges() {
  requestAnimationFrame(() => {
    const forest = document.querySelector<HTMLElement>(".iteration-forest");
    if (!forest) {
      iterationEdgeObserver?.disconnect();
      return;
    }
    drawIterationEdges(forest);
    if (!iterationEdgeObserver) {
      iterationEdgeObserver = new ResizeObserver(() => {
        const current = document.querySelector<HTMLElement>(".iteration-forest");
        if (current) {
          drawIterationEdges(current);
        }
      });
    }
    // render() ごとに forest 要素は作り直されるため、観測対象を貼り直す。
    iterationEdgeObserver.disconnect();
    iterationEdgeObserver.observe(forest);
    const tracker = forest.closest(".iteration-tracker");
    if (tracker) {
      iterationEdgeObserver.observe(tracker);
    }
  });
}

function renderHeader() {
  const connection = getConnectionView();
  return `
    <header class="app-header">
      <div class="header-left">
        <button class="icon-button menu-button" data-action="toggle-sidebar" type="button" aria-label="設定を開く">${iconMenu()}</button>
        <button class="brand" data-action="home" type="button">
          <span class="brand-mark"><img src="/spiral.svg" alt="" draggable="false" /></span>
          <span>
            <strong>GURUGURU</strong>
            <small>Iterative Generation Studio</small>
          </span>
        </button>
      </div>
      <div class="header-right">
        <button class="connection" type="button" data-action="check-comfy-connection" title="クリックして接続状態を再確認" ${state.comfyConnection === "checking" ? "disabled" : ""}>
          <span class="status-dot ${connection.className}"></span>
          <span title="${escapeAttr(state.comfyStatusText)}">${escapeHtml(connection.label)}</span>
        </button>
      </div>
    </header>
  `;
}

function getConnectionView() {
  if (state.busy) {
    return { className: "generating", label: "生成送信中..." };
  }
  if (state.comfyConnection === "connected") {
    return { className: "connected", label: "ComfyUI 接続済み" };
  }
  if (state.comfyConnection === "checking") {
    return { className: "checking", label: "接続確認中" };
  }
  if (state.comfyConnection === "disconnected") {
    return { className: "disconnected", label: "ComfyUI 未接続" };
  }
  return { className: "unknown", label: "ComfyUI 未確認" };
}

function renderProjectDetailView(detail: ProjectDetail) {
  const activeRound = getActiveRound(detail);
  const assets = getActiveRoundAssets().filter(assetPassesFilter);
  const selectedAssets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const roundActive = isRoundActive(activeRound);

  return renderProjectDetail(
    detail,
    activeRound,
    assets,
    selectedAssets,
    state.sidebarOpen,
    state.gridCols,
    roundActive,
    state.activeRoundId,
    state.deletePreviewRoundId,
    state.busy,
    renderGenerationPanelView(detail, activeAsset),
    (assetId: string) => inpaintDraftForAsset(assetId),
    (assetId: string) => poseDraftForAsset(assetId),
    state.showMaskGridTag,
    state.copiedSeedAssetId,
    state.sidebarCollapsed
  );
}

function renderGenerationPanelView(detail: ProjectDetail, activeAsset: Asset | null) {
  const activeRound = getActiveRound(detail);
  const draft = state.generationDraft;
  const draftParent = findAsset(draft?.parentAssetId ?? "");
  const previous = activeAsset ?? draftParent ?? getPreferredParentAsset();
  const activeInpaint = previous?.id ? inpaintDraftForAsset(previous.id) : null;
  const llmConfigured = Boolean(state.llmSettings?.baseUrl.trim() && state.llmSettings?.model.trim());
  return renderGenerationPanel(detail, activeRound, previous, draft, activeInpaint, llmConfigured, state.llmImproving);
}

function renderAssetModalView() {
  const asset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  if (!asset) {
    return "";
  }
  const inpaint = inpaintDraftForAsset(asset.id);
  const editing = state.maskEditMode;
  const promptValue = currentPositivePromptValue(asset);
  const batchSizeValue = currentBatchSizeValue();
  const paintDraft = state.paintEditMode ? paintDraftForAsset(asset.id) ?? defaultPaintDraft(asset.id) : null;
  const poseDraft = poseDraftForAsset(asset.id);
  const generationParams: MaskGenerationParams = {
    steps: currentStepsValue(),
    cfg: currentCfgValue(),
    denoise: currentDenoiseValue(),
    width: currentWidthValue(),
    height: currentHeightValue(),
    seed: currentSeedValue(),
    seedMode: currentSeedModeValue(),
    sampler: currentSamplerValue(),
    scheduler: currentSchedulerValue()
  };
  return renderAssetModal(
    asset,
    inpaint,
    editing,
    promptValue,
    batchSizeValue,
    state.maskPanelWidths,
    state.paintEditMode,
    paintDraft,
    state.maskPanelTab,
    poseDraft,
    generationParams,
    state.sidebarCollapsed,
    getSelectedPoseEdges()
  );
}


