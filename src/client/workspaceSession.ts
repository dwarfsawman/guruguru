/**
 * 画面遷移(Home / プロジェクト / Book / ページ)時のセッション状態リセットの集約。
 *
 * 以前は `loadHome` / `openProject` / `openBook`(projectController.ts / bookController.ts)/
 * `openPage` / `backToPages` の5箇所に、微妙に異なる部分集合の手書きリセットが5重に存在した
 * (監査 2026-07-21)。リセット対象フィールドの列挙をここへ一元化し、今後フィールドを増やす時に
 * 5箇所へ書き足す事故を防ぐ。
 *
 * スコープは2段:
 * - `resetPageWorkspaceState()` … ページ内容に紐づくフォーム/編集UI状態。ページ切替・グリッド復帰を
 *   含む全遷移で消す。
 * - `resetProjectWorkspaceState()` … 上記+プロジェクトを開く/離れる時にだけ消すもの
 *   (Round削除undo履歴・貼り付けキャッシュはプロジェクトスコープなので、ページ内遷移では保持する)。
 *
 * draft の永続化(localStorage)方向は逆に「消す前に退避する」必要があるので、
 * `stashActivePageFormDrafts()` を遷移の**先頭**(state を触る前・フォームがまだ DOM にある間)に呼ぶ。
 */
import { state } from "./appState";
import { commitActivePageDrafts, flushProjectDraftPersist } from "./draftStore";
import { rememberActiveRoundDraft } from "./generationDraft";
import { resetRoundDeletionHistory } from "./generationController";
import { clearPasteCaches } from "./pasteObjectController";

/**
 * 離脱前に、生成フォームの未保存編集を現ラウンドの draft へ・参照/LoRA/生成設定を per-page マップへ
 * 退避し、保留中の localStorage 書き込みを確定する。#generation-form がまだ DOM にあり
 * `state.activeRoundId` / `state.currentProjectId` を書き換える前のタイミングで呼ぶこと
 * (以前は `backToPages` だけがこの3点セットを行い、`loadHome` は rememberActiveRoundDraft を
 * 呼ばずページ内編集が失われていた -- 監査で漏れバグ判定)。
 */
export function stashActivePageFormDrafts(): void {
  rememberActiveRoundDraft();
  commitActivePageDrafts();
  flushProjectDraftPersist();
}

/**
 * ページに紐づくセッション状態のリセット。サイト固有の値(detail/activeRoundId/
 * pagePanelAssignments 等をフェッチ結果で埋める・activePageId の設定)は、これを呼んだ後に
 * 呼び出し側で上書きする。
 */
export function resetPageWorkspaceState(): void {
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  state.activePanelTarget = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  state.roundProgress = {};
  state.iterationScrollReset = true;
}

/**
 * 画面遷移の世代カウンタ。遷移系 async 関数(openProject/openBook/openPage)は冒頭で
 * `beginNavigation()` を取得し、await 後に `isCurrentNavigation()` で検証してから state へ
 * 書き込む -- 遅いレスポンスの旧遷移が新しい画面を上書きする out-of-order レースを防ぐ。
 */
let navigationSerial = 0;

export function beginNavigation(): number {
  navigationSerial += 1;
  return navigationSerial;
}

export function isCurrentNavigation(serial: number): boolean {
  return serial === navigationSerial;
}

/** プロジェクトを開く/離れる時のリセット(ページスコープ+プロジェクトスコープ)。 */
export function resetProjectWorkspaceState(): void {
  resetPageWorkspaceState();
  resetRoundDeletionHistory();
  clearPasteCaches();
}
