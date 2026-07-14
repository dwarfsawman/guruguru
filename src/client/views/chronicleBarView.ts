/**
 * Chronicle バー(S5、Docs/Done/Feature-ChroniclePageFlow.md)の描画。ページ編集 lightbox 下部の
 * 折り畳み可能な脚本タイムライン。フェーズI: 横スクロール一覧・状態色分け・現在ページ範囲強調・
 * Beat クリックでの内容プレビュー表示。フェーズII: 範囲選択(Shift+クリック)のハイライト・
 * 選択サマリ(文字数・発話数・推定吹き出し数)・他ページ配置の警告・一括割り当て/解除ボタン・
 * ポリシー(skip/move/copy)選択・「次の未配置区間へ」ボタン(自動配置 preview/apply はフェーズIII)。
 */
import type {
  ChronicleBeat,
  ChronicleLineSummary,
  ChroniclePageSummary,
  DialogueLayoutPreview,
  ExistingPlacementPolicy
} from "../../shared/chronicle";
import type { MangaScript } from "../../shared/apiTypes";
import { buildBeatPreview, computeBeatState, currentPageBeatIds } from "../../shared/chronicleBeat";
import { escapeAttr, escapeHtml } from "../format";
import { iconChevron } from "../icons";

export interface ChronicleBarViewState {
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  collapsed: boolean;
  scripts: MangaScript[];
  scriptId: string | null;
  beats: ChronicleBeat[];
  lines: ChronicleLineSummary[];
  pages: ChroniclePageSummary[];
  currentPageId: string;
  previewBeatId: string | null;
  /** フェーズII: Shift+クリックで選択中の Beat id(§2.3)。 */
  selectedBeatIds: string[];
  /** フェーズII: 一括割り当て時の他ページ配置ポリシー(§3、既定 "skip")。 */
  allocationPolicy: ExistingPlacementPolicy;
  /** フェーズII/III: 一括割り当て/解除・配置案/確定の実行中ガード(§4)。ボタンの disabled/表示に使う。 */
  busyAction: null | "assign" | "preview" | "apply" | "reflow";
  /** フェーズIII(§2.3・§3): 直近の preview API 結果。null=未実施/キャンセル/確定済み。 */
  preview: DialogueLayoutPreview | null;
}

const POLICY_LABEL: Record<ExistingPlacementPolicy, string> = {
  skip: "スキップ",
  move: "移動",
  copy: "複製"
};

const STATUS_LABEL: Record<string, string> = {
  unassigned: "未配置",
  assigned: "配置済み",
  materialized: "吹き出し化済み",
  otherPage: "他ページに配置",
  orphaned: "削除済み(orphan)"
};

/**
 * バー本体。脚本が1件も無ければ(呼び出し側が status="idle" かつ scripts.length===0 のまま渡すので)
 * 何も出さない -- 表示条件(§2.1: Book かつ脚本1件以上かつ有効 revision)はここで最終判定する。
 */
export function renderChronicleBar(view: ChronicleBarViewState): string {
  if (view.scripts.length === 0) {
    return "";
  }
  const lineSummaryById = new Map(view.lines.map((line) => [line.lineId, line]));

  // <select> の change イベントは main.ts の change 委譲(既存 if/else チェーン)に新たな分岐を
  // 追加することになる(AGENTS.md「main.ts へ関数追加禁止」の趣旨に反しないが、既存 click 委譲
  // (registerActions)だけで完結させたいため)、クリックのみで完結するボタン列で複数脚本セレクタを表す。
  const scriptSelector =
    view.scripts.length > 1
      ? `<div class="chronicle-bar-script-tabs" role="tablist" aria-label="脚本を選択">
          ${view.scripts
            .map(
              (script) => `
                <button type="button" class="chronicle-bar-script-tab${script.id === view.scriptId ? " is-active" : ""}"
                  data-action="select-chronicle-script" data-id="${escapeAttr(script.id)}" role="tab"
                  aria-selected="${script.id === view.scriptId ? "true" : "false"}">
                  ${escapeHtml(script.title.trim() || "(無題の脚本)")}
                </button>
              `
            )
            .join("")}
        </div>`
      : view.scripts[0]
        ? `<span class="chronicle-bar-script-name">${escapeHtml(view.scripts[0].title.trim() || "(無題の脚本)")}</span>`
        : "";

  const hasUnassigned = view.beats.some(
    (beat) => computeBeatState(beat, lineSummaryById, view.currentPageId).status === "unassigned"
  );
  const nextUnassignedButton = `
    <button type="button" class="chronicle-bar-next-unassigned" data-action="jump-chronicle-next-unassigned"
      ${hasUnassigned ? "" : "disabled"}>
      次の未配置区間へ
    </button>
  `;

  // フェーズIV(§2.6・§6): 現在ページの materialized かつ auto_layout_locked=0 の placement 数(再配置対象)・
  // auto_layout_locked=1 の placement 数(一括解除対象)をバー全体のトグルボタン用に集計する。
  const currentPagePlacements = view.lines.flatMap((line) => line.placements.filter((placement) => placement.pageId === view.currentPageId));
  const currentBeatIds = new Set(currentPageBeatIds(view.beats, lineSummaryById, view.currentPageId));
  const reflowEligibleCount = currentPagePlacements.filter((placement) => placement.balloonObjectId && !placement.autoLayoutLocked).length;
  const lockedCount = currentPagePlacements.filter((placement) => placement.autoLayoutLocked).length;
  const busy = view.busyAction !== null;
  const reflowButton = `
    <button type="button" class="chronicle-bar-reflow" data-action="reflow-chronicle-layout"
      ${busy || reflowEligibleCount === 0 ? "disabled" : ""}
      title="現在ページの未ロック吹き出し(${reflowEligibleCount}件)を新しい seed で再配置します">
      ${view.busyAction === "reflow" ? "再配置中…" : "再配置"}
    </button>
  `;
  const unlockAllButton = `
    <button type="button" class="chronicle-bar-unlock-all" data-action="unlock-all-chronicle-placements"
      ${lockedCount === 0 ? "disabled" : ""} title="現在ページのロックを一括解除します(${lockedCount}件)">
      ロック解除(${lockedCount})
    </button>
  `;

  const body = view.collapsed
    ? ""
    : view.status === "loading"
      ? `<div class="chronicle-bar-message">読み込み中…</div>`
      : view.status === "error"
        ? `<div class="chronicle-bar-message chronicle-bar-message-error">${escapeHtml(view.errorMessage ?? "Chronicle の取得に失敗しました。")}</div>`
        : view.beats.length === 0
          ? `<div class="chronicle-bar-message">セリフがまだありません。</div>`
          : `<div class="chronicle-bar-toolbar">${nextUnassignedButton}${reflowButton}${unlockAllButton}</div>
            <div class="chronicle-bar-track${currentBeatIds.size > 0 ? " has-current-page-lines" : ""}">
              ${view.beats
                .map((beat) => {
                  const expanded = view.previewBeatId === beat.id;
                  const chip = renderBeatChip(beat, lineSummaryById, view.currentPageId, view.selectedBeatIds, expanded);
                  // B-2(Docs/Feature-PageEditSidebarUx.md 課題B): アコーディオン展開部はチップの直後
                  // (同じ .chronicle-bar-track 内の次の兄弟要素)に差し込む -- <button> の中に
                  // <button>(ジャンプ/ロック解除)は入れられないため、チップ自身の子にはせず、
                  // 直下に並べることで「そのチップの下に開く」見た目を作る(track はサイドバー内では
                  // 縦積みの column flex になる)。
                  const accordion = expanded ? renderBeatAccordion(beat, view, lineSummaryById) : "";
                  return `${chip}${accordion}`;
                })
                .join("")}
            </div>
            ${view.selectedBeatIds.length > 0 ? renderSelectionPanel(view, lineSummaryById) : ""}
            ${view.preview ? renderLayoutPreviewPanel(view) : ""}`;

  return `
    <section class="chronicle-bar${view.collapsed ? " is-collapsed" : ""}" aria-label="Chronicle バー">
      <header class="chronicle-bar-header">
        <button class="chronicle-bar-collapse-toggle" type="button" data-action="toggle-chronicle-collapsed"
          aria-expanded="${view.collapsed ? "false" : "true"}" title="${view.collapsed ? "展開" : "折り畳み"}">
          <span class="chronicle-bar-collapse-icon">${iconChevron()}</span>
          <span class="section-kicker">Chronicle</span>
        </button>
        ${scriptSelector}
      </header>
      ${body}
    </section>
  `;
}

function renderBeatChip(
  beat: ChronicleBeat,
  lineSummaryById: Map<string, ChronicleLineSummary>,
  currentPageId: string,
  selectedBeatIds: string[],
  expanded: boolean
): string {
  const beatState = computeBeatState(beat, lineSummaryById, currentPageId);
  const isCurrentPage = beatState.currentPageLineCount > 0;
  const classes = ["chronicle-beat", `is-status-${beatState.status}`];
  if (isCurrentPage) {
    classes.push("is-current-page");
  }
  if (beatState.locked) {
    classes.push("is-locked");
  }
  if (selectedBeatIds.includes(beat.id)) {
    classes.push("is-selected");
  }
  if (expanded) {
    classes.push("is-expanded");
  }
  const lines = beat.lineIds.map((id) => lineSummaryById.get(id)).filter((line): line is ChronicleLineSummary => Boolean(line));
  const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);
  const countLabel = `${lines.length}セリフ・${charCount}字`;
  return `
    <button type="button" class="${classes.join(" ")}" data-action="toggle-chronicle-beat-preview" data-id="${escapeAttr(beat.id)}"
      title="${escapeAttr(`代表セリフ: ${beat.label}「${beat.summary}」\n${countLabel}\nクリックでセリフ一覧 / Shift+クリックで範囲選択`)}"
      aria-label="${escapeAttr(`${STATUS_LABEL[beatState.status] ?? beatState.status}、${countLabel}`)}"
      ${isCurrentPage ? `aria-current="true"` : ""}
      aria-pressed="${selectedBeatIds.includes(beat.id) ? "true" : "false"}"
      aria-expanded="${expanded ? "true" : "false"}">
      <span class="chronicle-beat-heading">
        <span class="chronicle-beat-label">${escapeHtml(beat.label)}</span>
        <span class="chronicle-beat-heading-end">
          <span class="chronicle-beat-count">${lines.length}セリフ</span>
          <span class="chronicle-beat-chevron" aria-hidden="true">${iconChevron()}</span>
        </span>
      </span>
      <span class="chronicle-beat-summary">${escapeHtml(beat.summary)}</span>
    </button>
  `;
}

/**
 * 選択サマリ+割り当て/解除操作パネル(§2.3)。文字数・発話数・推定吹き出し数(=行数)を表示し、
 * 他ページ配置済み行が選択に含まれる場合は警告を出す(既定 skip のまま実行可)。
 */
function renderSelectionPanel(view: ChronicleBarViewState, lineSummaryById: Map<string, ChronicleLineSummary>): string {
  const selectedBeats = view.beats.filter((beat) => view.selectedBeatIds.includes(beat.id));
  const lineIds = Array.from(new Set(selectedBeats.flatMap((beat) => beat.lineIds)));
  const lines = lineIds.map((id) => lineSummaryById.get(id)).filter((value): value is ChronicleLineSummary => Boolean(value));
  const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);
  const lineCount = lines.length;
  const hasOtherPageLines = lines.some(
    (line) => line.placements.length > 0 && !line.placements.some((placement) => placement.pageId === view.currentPageId)
  );
  const hasMaterializedOnCurrentPage = lines.some((line) =>
    line.placements.some((placement) => placement.pageId === view.currentPageId && placement.balloonObjectId)
  );
  const busy = view.busyAction === "assign";
  const layoutBusy = view.busyAction === "preview" || view.busyAction === "apply";
  // 配置案の対象(§2.3): 選択に含まれる行のうち、現在ページ配置済み・かつ未吹き出し化の行だけ。
  const previewTargetCount = lines.filter(
    (line) => line.placements.some((placement) => placement.pageId === view.currentPageId && !placement.balloonObjectId)
  ).length;

  return `
    <div class="chronicle-selection-panel">
      <div class="chronicle-selection-stats">
        <span>${selectedBeats.length}区間選択中</span>
        <span>${lineCount}発話</span>
        <span>${charCount}字</span>
        <span>吹き出し見込み ${lineCount}個</span>
      </div>
      ${
        hasOtherPageLines
          ? `<div class="chronicle-selection-warning">選択に他ページ配置済みの行が含まれています(既定では動かしません)。</div>`
          : ""
      }
      ${
        hasMaterializedOnCurrentPage
          ? `<div class="chronicle-selection-warning">選択に吹き出し化済みの行が含まれています(割り当て解除の対象外)。</div>`
          : ""
      }
      <div class="chronicle-selection-policy-tabs" role="tablist" aria-label="他ページ配置済み行の扱い">
        ${(["skip", "move", "copy"] as const)
          .map(
            (policy) => `
              <button type="button" class="chronicle-selection-policy-tab${policy === view.allocationPolicy ? " is-active" : ""}"
                data-action="select-chronicle-allocation-policy" data-id="${policy}" role="tab"
                aria-selected="${policy === view.allocationPolicy ? "true" : "false"}">
                ${POLICY_LABEL[policy]}
              </button>
            `
          )
          .join("")}
      </div>
      <div class="chronicle-selection-actions">
        <button type="button" class="button-primary compact" data-action="assign-chronicle-selection" ${busy ? "disabled" : ""}>
          現在ページへ割り当て
        </button>
        <button type="button" class="button-secondary compact" data-action="remove-chronicle-selection" ${busy ? "disabled" : ""}>
          割り当て解除
        </button>
        <button type="button" class="button-secondary compact" data-action="clear-chronicle-selection" ${busy ? "disabled" : ""}>
          選択を解除
        </button>
      </div>
      <div class="chronicle-selection-actions chronicle-layout-actions">
        <button type="button" class="button-primary compact" data-action="preview-chronicle-layout"
          ${layoutBusy || previewTargetCount === 0 ? "disabled" : ""} title="選択中の未吹き出し化の行(${previewTargetCount}件)を仮配置します">
          ${view.busyAction === "preview" ? "配置案を計算中…" : "配置案"}
        </button>
        ${
          view.preview
            ? `
              <button type="button" class="button-primary compact" data-action="apply-chronicle-layout"
                ${layoutBusy || view.preview.unplacedPlacementIds.length > 0 ? "disabled" : ""}>
                ${view.busyAction === "apply" ? "確定中…" : "確定"}
              </button>
              <button type="button" class="button-secondary compact" data-action="cancel-chronicle-layout" ${layoutBusy ? "disabled" : ""}>
                キャンセル
              </button>
            `
            : ""
        }
      </div>
    </div>
  `;
}

/**
 * 配置案プレビューのサマリ(§2.3・§4)。ゴースト本体はページ編集ステージ側(`pagePanelLightboxView.ts`)が
 * `state.chronicle.preview` を直接参照して描く -- ここは seed・件数・警告のテキストサマリのみ。
 */
function renderLayoutPreviewPanel(view: ChronicleBarViewState): string {
  const preview = view.preview;
  if (!preview) {
    return "";
  }
  return `
    <div class="chronicle-layout-preview-panel">
      <div class="chronicle-layout-preview-stats">
        <span>seed ${preview.seed}</span>
        <span>配置 ${preview.objects.length}件</span>
        ${preview.unplacedPlacementIds.length > 0 ? `<span class="is-warning">未配置 ${preview.unplacedPlacementIds.length}件</span>` : ""}
      </div>
      ${
        preview.warnings.length > 0
          ? `<ul class="chronicle-layout-preview-warnings">${preview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
          : ""
      }
    </div>
  `;
}

/**
 * B-2(Docs/Feature-PageEditSidebarUx.md 課題B): クリックした Beat チップの直下に差し込むアコーディオン
 * 展開部(旧 `renderBeatPreview`)。中身 -- 行ごとの話者/本文/配置状態、「対応吹き出しへジャンプ」
 * (フェーズIV §2.6・§6、現在ページ配置済み・吹き出し化済みの行のみクリック可)、ロック解除(現在ページで
 * ロック済みの行のみ) -- は維持しつつ、「セリフ一覧」「タグは先頭セリフを代表表示」の見出し行は削除する
 * (行数・文字数サマリは既にチップ側 `chronicle-beat-count`/title 属性にあるため重複表示しない、ユーザー明示要望)。
 */
function renderBeatAccordion(
  beat: ChronicleBeat,
  view: ChronicleBarViewState,
  lineSummaryById: Map<string, ChronicleLineSummary>
): string {
  const preview = buildBeatPreview(beat, lineSummaryById, view.pages);
  return `
    <div class="chronicle-beat-accordion">
      <ul class="chronicle-beat-preview-lines">
        ${preview.lines
          .map((line) => {
            const summary = lineSummaryById.get(line.lineId);
            const currentPagePlacement = summary?.placements.find((placement) => placement.pageId === view.currentPageId);
            const jumpable = Boolean(currentPagePlacement?.balloonObjectId);
            const locked = Boolean(currentPagePlacement?.autoLayoutLocked);
            const speakerLabel = currentPagePlacement?.speakerLabelOverride ?? line.speakerLabel;
            const text = currentPagePlacement?.renderedText ?? currentPagePlacement?.textOverride ?? line.text;
            return `
              <li class="chronicle-beat-preview-line${locked ? " is-locked" : ""}${currentPagePlacement ? " is-current-page" : ""}">
                ${
                  jumpable
                    ? `<button type="button" class="chronicle-beat-preview-jump" data-action="select-chronicle-line-object"
                        data-id="${escapeAttr(line.lineId)}" title="対応する吹き出しを選択">`
                    : `<span class="chronicle-beat-preview-jump chronicle-beat-preview-jump-disabled">`
                }
                  <span class="chronicle-beat-preview-speaker">${escapeHtml(speakerLabel || "(話者未設定)")}</span>
                  <span class="chronicle-beat-preview-text">${escapeHtml(text)}</span>
                  <span class="chronicle-beat-preview-page">${currentPagePlacement ? "このページ" : line.pageIndex === null ? "未配置" : `${line.pageIndex + 1}ページ`}</span>
                ${jumpable ? "</button>" : "</span>"}
                ${
                  locked && currentPagePlacement
                    ? `<button type="button" class="chronicle-beat-preview-unlock" data-action="unlock-chronicle-placement"
                        data-id="${escapeAttr(currentPagePlacement.id)}" title="このロックを解除">🔓</button>`
                    : ""
                }
              </li>
            `;
          })
          .join("")}
      </ul>
    </div>
  `;
}
