import type {
  Asset,
  AssetParent,
  ProjectDetail
} from "../shared/apiTypes";
import {
  iconClose,
  iconMenu
} from "./icons";
import { escapeAttr, escapeHtml, formatNumber, formatSliderValue } from "./format";
import { morph } from "./domMorph";
import { renderModelInstallModal } from "./workflowUi";
import { renderHome, type ConnectionState, type ConnectionSummary } from "./views/homeView";
import { renderBookView } from "./views/bookView";
import { renderBookSettingsView } from "./views/bookSettingsView";
import { renderBookReaderView } from "./views/bookReaderView";
import { renderIterationTracker } from "./views/iterationTree";
import { drawIterationEdges } from "./views/iterationTreeEdges";
import { renderProjectDetail, renderSourceUploadButton } from "./views/galleryView";
import { renderGenerationPanel } from "./views/generationPanel";
import { renderAssetModal, type MaskGenerationParams } from "./views/assetModal";
import {
  dismissToast,
  pushToast,
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
  handleMaskEditorKeydown,
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
import { delay, isTextEntryTarget } from "./clientUtils";
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
import "./edgePopoutController";
import "./imageLightboxController";
import "./modelCheckController";
import "./bookController";
import { handleBookReaderKeydown } from "./bookReaderController";
import {
  deselectPasteObjectIfAny,
  handlePasteKeydown,
  handlePastePointerCancel,
  handlePastePointerDown,
  handlePastePointerMove,
  handlePastePointerUp,
  pasteEnabledForGridAsset,
  pasteObjectsForGridAsset,
  syncAssetModalPasteObjects,
  syncGridPasteCanvases,
  syncPasteGizmoScale
} from "./pasteObjectController";
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
  redoRoundDeletion,
  selectAllActiveRound,
  undoRoundDeletion
} from "./generationController";
import {
  closeWorkflowModals,
  loadHome,
  uploadSourceAsset
} from "./projectController";
import { referenceFeatureAvailability, uploadReferenceImage } from "./referenceController";
import {
  handleSidebarResizePointerCancel,
  handleSidebarResizePointerDown,
  handleSidebarResizePointerMove,
  handleSidebarResizePointerUp
} from "./sidebarResizeController";
import { refreshLoraChoices, updateStyleLoraFromControl } from "./styleLoraController";
import { closeAssetDetail } from "./assetDetailController";
import { closeShortcutsHelp, handleAssetActionShortcuts, renderShortcutsHelpModal, toggleShortcutsHelp } from "./shortcuts";

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
    if (target.classList.contains("shortcuts-help-modal")) {
      closeShortcutsHelp();
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
        pushToast(error instanceof Error ? error.message : String(error), "error");
        render();
      });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.referenceUpload) {
      void uploadReferenceImage(target).catch((error) => {
        pushToast(error instanceof Error ? error.message : String(error), "error");
        render();
      });
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
    if (target.dataset.loraField) {
      updateStyleLoraFromControl(target);
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
    if (target.dataset.loraField && target instanceof HTMLInputElement) {
      updateStyleLoraFromControl(target);
    }
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

  app.addEventListener("wheel", (event) => {
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
      // wheel tick は render を経ないため、ギズモのハンドルサイズだけ直接再計算する。
      syncPasteGizmoScale();
    } else {
      handleMaskWheelZoom(event);
    }
  }, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (state.showShortcutsHelp && event.key === "Escape") {
      closeShortcutsHelp();
      return;
    }
    if (event.key === "?" && !isTextEntryTarget(event.target)) {
      event.preventDefault();
      toggleShortcutsHelp();
      return;
    }

    // Book Reader が開いている間はページ送り/閉じるを最優先で処理する（detail とは排他）。
    if (handleBookReaderKeydown(event)) {
      return;
    }

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
      } else if (deselectPasteObjectIfAny()) {
        // Esc カスケード第2段: 貼り付けオブジェクトの選択解除(モーダルは閉じない)。
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
      // アセットモーダルが開いていない時だけ Round 削除の undo/redo を受け付ける
      // (モーダル内の Ctrl+Z はペイント編集の undo が使う)。
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          void undoRoundDeletion();
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          void redoRoundDeletion();
        }
      }
      return;
    }

    if (handlePasteKeydown(event)) {
      return;
    }

    if (handleMaskEditorKeydown(event)) {
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
    if (handleSidebarResizePointerDown(event)) {
      return;
    }
    if (handlePoseEditorPointerDown(event)) {
      return;
    }
    if (handleMaskEditorPointerDown(event)) {
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (handlePastePointerDown(event, target)) {
      return;
    }
    if (handlePaintEditorPointerDown(event, target)) {
      return;
    }
    handleMaskStrokeStartPointerDown(event);
  });

  app.addEventListener("pointermove", (event) => {
    if (handleSidebarResizePointerMove(event)) {
      return;
    }
    if (handleMaskEditorPointerMove(event)) {
      return;
    }
    if (handleWebSamPointerMove(event)) {
      return;
    }
    if (handlePoseEditorPointerMove(event)) {
      return;
    }
    if (handlePastePointerMove(event)) {
      return;
    }
    if (handlePaintEditorPointerMove(event)) {
      return;
    }
    handleMaskStrokePointerMove(event);
  });

  app.addEventListener("pointerup", (event) => {
    if (handleSidebarResizePointerUp(event)) {
      return;
    }
    if (handleMaskEditorPointerUp(event)) {
      return;
    }
    if (handleWebSamPointerUp(event)) {
      return;
    }
    if (handlePoseEditorPointerUp(event)) {
      return;
    }
    if (handlePastePointerUp(event)) {
      return;
    }
    if (handlePaintEditorPointerUp(event)) {
      return;
    }
    handleMaskStrokePointerUp(event);
  });

  app.addEventListener("pointercancel", (event) => {
    if (handleSidebarResizePointerCancel(event)) {
      return;
    }
    if (handleMaskEditorPointerCancel(event)) {
      return;
    }
    if (handleWebSamPointerCancel(event)) {
      return;
    }
    if (handlePoseEditorPointerCancel(event)) {
      return;
    }
    if (handlePastePointerCancel(event)) {
      return;
    }
    if (handlePaintEditorPointerCancel(event)) {
      return;
    }
    handleMaskStrokePointerCancel(event);
  });

  bindRegisteredEvents(app);
}

async function handleAction(action: string, id: string, target: HTMLElement) {
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
      dismissToast(id);
    } else if (action === "copy-seed") {
      const seedText = target.dataset.seed ?? "";
      if (seedText) {
        try {
          await navigator.clipboard.writeText(seedText);
        } catch {
          pushToast("クリップボードへのコピーに失敗しました。", "error");
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
    pushToast(error instanceof Error ? error.message : String(error), "error");
    render();
  }
}

// 領域ごとの前回 HTML。全領域が前回と一致する場合は DOM パッチ自体をスキップする。
let lastRegionHtml: string[] | null = null;

function render(_options: RenderOptions = {}) {
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
  const regions = [
    renderHeader(),
    renderToastStack(),
    state.detail
      ? renderProjectDetailView(state.detail)
      : state.bookReaderOpen && state.book
        ? renderBookReaderView(
            state.book,
            state.bookReaderPageIndex,
            state.bookReaderSettings,
            state.bookReaderSettingsOpen
          )
        : state.bookSettingsOpen && state.book
        ? renderBookSettingsView(
            state.book.project.name,
            renderBookSettingsPanelView(),
            state.sidebarCollapsed,
            state.sidebarWidth,
            state.bookCommonSettings !== null
          )
        : state.book
          ? renderBookView(state.book)
          : renderHome(
            state.projects,
            state.settings,
            state.templates,
            state.llmSettings,
            { state: state.comfyConnection, text: state.comfyStatusText } satisfies ConnectionSummary,
            { state: state.llmConnection, text: state.llmStatusText } satisfies ConnectionSummary,
            state.createProjectMode
          ),
    renderAssetModalView(),
    renderShortcutsHelpModal(state.showShortcutsHelp),
    renderModelInstallModal(state.modelInstallFamily, state.modelCheck)
  ];
  const changed = !lastRegionHtml || regions.some((html, i) => html !== lastRegionHtml![i]);
  if (changed) {
    morph(app, `
    ${regions[0]}
    ${regions[1]}
    ${regions[2]}
    ${regions[3]}
    ${regions[4]}
    ${regions[5]}
  `);
    lastRegionHtml = regions;
  }
  invalidateMaskBrushCursorCache();
  resetIterationScrollIfRequested();
  refreshIterationEdges();
  syncAssetModalMaskCanvas();
  syncAssetModalPaintCanvas();
  syncAssetModalPasteObjects();
  syncGridPasteCanvases();
}

/**
 * morph 化により .iteration-tracker のスクロール位置は再レンダーをまたいで自然に保持される。
 * プロジェクトを開き直した時など「先頭に戻したい」場面だけ明示フラグでリセットする。
 */
function resetIterationScrollIfRequested() {
  if (!state.iterationScrollReset) {
    return;
  }
  state.iterationScrollReset = false;
  const tracker = document.querySelector<HTMLElement>(".iteration-tracker");
  if (tracker) {
    tracker.scrollLeft = 0;
    tracker.scrollTop = 0;
  }
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
    // morph の結果 forest 要素が入れ替わる場合があるため、観測対象を毎回貼り直す。
    iterationEdgeObserver.disconnect();
    iterationEdgeObserver.observe(forest);
    const tracker = forest.closest(".iteration-tracker");
    if (tracker) {
      iterationEdgeObserver.observe(tracker);
    }
  });
}

function renderToastStack() {
  if (state.toasts.length === 0) {
    return "";
  }
  const items = state.toasts.map((toast) => `
    <div class="message message-${toast.type}" data-key="${escapeAttr(toast.id)}">
      <pre class="message-text">${escapeHtml(toast.text)}</pre>
      ${toast.action ? `<button class="button-secondary compact message-action" type="button" data-action="${escapeAttr(toast.action.action)}"${toast.action.id ? ` data-id="${escapeAttr(toast.action.id)}"` : ""}>${escapeHtml(toast.action.label)}</button>` : ""}
      <button class="message-close" type="button" data-action="dismiss-message" data-id="${escapeAttr(toast.id)}" aria-label="メッセージを閉じる" title="閉じる">${iconClose()}</button>
    </div>
  `).join("");
  return `<div class="message-stack" data-key="message-stack">${items}</div>`;
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
        <button class="icon-button shortcuts-help-button" data-action="toggle-shortcuts-help" type="button" aria-label="キーボードショートカット一覧" title="キーボードショートカット一覧 (?)">?</button>
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
  const selectedAssets = getActiveRoundAssets().filter((asset) => asset.status === "selected").slice(0, 1);
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const roundActive = isRoundActive(activeRound);
  // Book のページを開いている時だけ、ラウンドツールバーに「← ページ一覧」パンくずを出す。
  const bookPage = getActiveBookPageContext();

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
    (assetId: string) => pasteObjectsForGridAsset(assetId).length,
    (assetId: string) => pasteEnabledForGridAsset(assetId),
    state.copiedSeedAssetId,
    state.sidebarCollapsed,
    state.roundProgress,
    bookPage,
    state.sidebarWidth
  );
}

function getActiveBookPageContext(): { title: string; number: number } | null {
  if (!state.activePageId || !state.book) {
    return null;
  }
  const index = state.book.pages.findIndex((page) => page.id === state.activePageId);
  const page = index >= 0 ? state.book.pages[index] : null;
  return page ? { title: page.title, number: index + 1 } : null;
}

function renderGenerationPanelView(detail: ProjectDetail, activeAsset: Asset | null) {
  const activeRound = getActiveRound(detail);
  const draft = state.generationDraft;
  const draftParent = findAsset(draft?.parentAssetId ?? "");
  const previous = activeAsset ?? draftParent ?? getPreferredParentAsset();
  const activeInpaint = previous?.id ? inpaintDraftForAsset(previous.id) : null;
  const llmConfigured = Boolean(state.llmSettings?.baseUrl.trim() && state.llmSettings?.model.trim());
  return renderGenerationPanel(
    detail,
    activeRound,
    previous,
    draft,
    activeInpaint,
    llmConfigured,
    state.llmImproving,
    state.referenceDraft,
    referenceFeatureAvailability(),
    state.loraDraft,
    state.loraChoices,
    state.recentReferenceImages
  );
}

/**
 * Book共通設定画面のサイドバー(生成パネル)を bookSettingsMode で render する。ラウンド/アセットの
 * 無い synthetic な ProjectDetail(templates と project だけ本物)を渡し、親画像/顔参照セクションは隠す。
 * 生成フォームの編集は既存ハンドラがそのまま state.generationDraft / state.loraDraft を更新する。
 */
function renderBookSettingsPanelView(): string {
  const syntheticDetail: ProjectDetail = {
    project: state.book!.project,
    rounds: [],
    assets: [],
    assetParents: [],
    templates: state.templates,
    pasteAttachments: {}
  };
  const llmConfigured = Boolean(state.llmSettings?.baseUrl.trim() && state.llmSettings?.model.trim());
  return renderGenerationPanel(
    syntheticDetail,
    null,
    null,
    state.generationDraft,
    null,
    llmConfigured,
    state.llmImproving,
    null,
    referenceFeatureAvailability(),
    state.loraDraft,
    state.loraChoices,
    [],
    true
  );
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
