/**
 * Chronicle バー(S5、Docs/Feature-ChroniclePageFlow.md)の描画。ページ編集 lightbox 下部の
 * 折り畳み可能な脚本タイムライン。フェーズI: 横スクロール一覧・状態色分け・現在ページ範囲強調・
 * Beat クリックでの内容プレビュー表示のみ(選択/一括割り当てはフェーズII 以降、UI は出さない)。
 */
import type { ChronicleBeat, ChronicleLineSummary, ChroniclePageSummary } from "../../shared/chronicle";
import type { MangaScript } from "../../shared/apiTypes";
import { buildBeatPreview, computeBeatState } from "../../shared/chronicleBeat";
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
}

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

  const body = view.collapsed
    ? ""
    : view.status === "loading"
      ? `<div class="chronicle-bar-message">読み込み中…</div>`
      : view.status === "error"
        ? `<div class="chronicle-bar-message chronicle-bar-message-error">${escapeHtml(view.errorMessage ?? "Chronicle の取得に失敗しました。")}</div>`
        : view.beats.length === 0
          ? `<div class="chronicle-bar-message">セリフがまだありません。</div>`
          : `<div class="chronicle-bar-track">
              ${view.beats.map((beat) => renderBeatChip(beat, lineSummaryById, view.currentPageId)).join("")}
            </div>
            ${view.previewBeatId ? renderBeatPreview(view, lineSummaryById) : ""}`;

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

function renderBeatChip(beat: ChronicleBeat, lineSummaryById: Map<string, ChronicleLineSummary>, currentPageId: string): string {
  const beatState = computeBeatState(beat, lineSummaryById, currentPageId);
  const isCurrentPage = beatState.currentPageLineCount > 0;
  const classes = ["chronicle-beat", `is-status-${beatState.status}`];
  if (isCurrentPage) {
    classes.push("is-current-page");
  }
  if (beatState.locked) {
    classes.push("is-locked");
  }
  return `
    <button type="button" class="${classes.join(" ")}" data-action="toggle-chronicle-beat-preview" data-id="${escapeAttr(beat.id)}"
      title="${escapeAttr(`${beat.label}: ${beat.summary}`)}" aria-label="${escapeAttr(STATUS_LABEL[beatState.status] ?? beatState.status)}">
      <span class="chronicle-beat-label">${escapeHtml(beat.label)}</span>
      <span class="chronicle-beat-summary">${escapeHtml(beat.summary)}</span>
    </button>
  `;
}

function renderBeatPreview(view: ChronicleBarViewState, lineSummaryById: Map<string, ChronicleLineSummary>): string {
  const beat = view.beats.find((item) => item.id === view.previewBeatId);
  if (!beat) {
    return "";
  }
  const preview = buildBeatPreview(beat, lineSummaryById, view.pages);
  return `
    <div class="chronicle-beat-preview">
      <ul class="chronicle-beat-preview-lines">
        ${preview.lines
          .map(
            (line) => `
              <li class="chronicle-beat-preview-line">
                <span class="chronicle-beat-preview-speaker">${escapeHtml(line.speakerLabel || "(話者未設定)")}</span>
                <span class="chronicle-beat-preview-text">${escapeHtml(line.text)}</span>
                <span class="chronicle-beat-preview-page">${line.pageIndex === null ? "未配置" : `${line.pageIndex + 1}ページ`}</span>
              </li>
            `
          )
          .join("")}
      </ul>
    </div>
  `;
}
