/**
 * ネームスタジオ(V5 D5): 候補=テイクをネームとして「読んで」選ぶ画面。
 * - 中央リーダー: レイアウトのワイヤーフレームSVGを背景に、コマのbboxへHTMLオーバーレイで
 *   構造ネーム(読み順・大きさ・ビート種別・内容・台詞量)を重ねる。
 * - レイアウトフリップ: rankLayouts(共有純関数)をクライアントで直接呼ぶのでゼロレイテンシ。
 *   選択は set-layout API が layout overrides として永続化(基礎プランは不変)。
 * - 右インスペクタ: 選択コマの詳細(採用後の演出ネーム/編集は P5)。
 */
import {
  buildPanelDemand,
  feasibleLayouts,
  type LayoutReason,
  type RankedLayout,
  selectDiverseLayouts
} from "../../shared/layoutMatcher";
import { resolveScriptMangaLayout } from "../../shared/layoutPresets";
import type { MangaVisualScale } from "../../shared/mangaPlanV2";
import { orderPanelsByReadingDirection } from "../../shared/dialogueAutoLayout";
import { type PageLayout, panelBounds } from "../../shared/pageLayout";
import { renderPageWireframeSvg, type WireframePanelInfo } from "../../shared/pageLayoutSvg";
import {
  applyCustomNameLayouts,
  applyLayoutOverrides,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelPlan,
  type ScriptMangaPlan
} from "../../shared/scriptMangaPlan";
import { LAYOUT_PAGE_MARGIN } from "../../shared/layoutPresets";
import { renderNameLayoutEditSvg, renderNameLayoutEditToolbar } from "./nameLayoutEditView";
import type { MangaPageSpec, MangaPlanV2, PanelSpec } from "../../shared/mangaPlanV2";
import type { ScriptMangaPlanCandidateView, ScriptMangaRunView } from "../../shared/scriptMangaApi";
import type { DialogueLine } from "../../shared/apiTypes";
import type { NameLayoutEditState, NamePoseEditState, NameStudioDraft, NameStudioState } from "../appState";
import { renderNamePoseEditToolbar, renderNamePoseOverlaySvg } from "./namePoseLayerView";
import {
  canonicalReaderIndex,
  getVisibleReaderPages,
  goNextReaderIndex,
  goPrevReaderIndex,
  readerPageLabel,
  type VisibleReaderPage
} from "../bookReader";
import { escapeAttr, escapeHtml } from "../format";
import { nameStudioReaderSettings } from "../nameStudioReader";
import { candidateDiffSignatures, candidatePageSignature, candidatePlanStructureSignature } from "./scriptView";

export const DIRECTED_TAKE_ID = "__directed__";

export interface NameStudioViewProps {
  activeScriptId: string | null;
  candidates: ScriptMangaPlanCandidateView[];
  beatKinds: Record<string, string>;
  dialogueChars: number[];
  /** Fixed-revision dialogue text used by the human-gate storyboard. */
  dialogueLines?: readonly DialogueLine[];
  candidatesBusy: boolean;
  runBusy: boolean;
  candidateCount: number;
  templateSelected: boolean;
  nameStudio: NameStudioState;
  /** 採用後の演出ネーム表示・編集(V5 D6)。 */
  run: ScriptMangaRunView | null;
  draft: NameStudioDraft | null;
  /** 人間ゲートのコマ割り修正セッション(非null中は該当ページを編集ステージで表示)。 */
  layoutEdit: NameLayoutEditState | null;
  /** ネームポーズレイヤの編集セッション(非null中は該当ページをポーズ編集ステージで表示)。 */
  poseEdit: NamePoseEditState | null;
}

const SCALE_LABELS: Record<MangaVisualScale, string> = {
  small: "小",
  medium: "中",
  large: "大",
  splash: "見開き級"
};

const BEAT_KIND_LABELS: Record<string, string> = {
  setup: "設定",
  action: "action",
  reaction: "反応",
  reveal: "reveal",
  decision: "決断",
  transition: "転換",
  pause: "間"
};

const REASON_LABELS: Record<LayoutReason["code"], string> = {
  "large-slot-aligned": "大ゴマが強調スロットに一致",
  "text-capacity-ok": "全コマの台詞収容OK",
  "capacity-tight": "台詞収容ぎりぎりのコマあり",
  "avoids-previous-layout": "前ページと別リズム",
  "bleed-preferred": "裁ち切りで見せ場向き",
  "default-order": "既定"
};

const SOURCE_TEXT_CLAMP = 120;
const FLIP_CHOICES = 3;

const SHOT_SIZE_LABELS: Record<string, string> = {
  "extreme-wide": "大引き",
  wide: "引き",
  medium: "ミディアム",
  "close-up": "寄り",
  insert: "インサート"
};

const DIRECTION_SOURCE_LABELS: Record<string, string> = {
  llm: "LLM演出",
  fallback: "未演出",
  human: "人間修正",
  provided: "provided"
};

/** 演出ネーム(run.plan)が編集可能か(承認済み/実行中/候補レビュー中は409になるため読み取り専用)。 */
export function directedPlanEditable(run: ScriptMangaRunView): boolean {
  return run.approvalStatus !== "approved" && !["running", "awaiting_review"].includes(run.status);
}

export function takeLabel(index: number): string {
  return `テイク${String.fromCharCode(65 + (index % 26))}`;
}

/** 表示・採用に使う実効プラン(基礎プラン+人間のフリップ+コマ割り修正)。 */
export function effectiveCandidatePlan(candidate: ScriptMangaPlanCandidateView): ScriptMangaPlan {
  return applyCustomNameLayouts(
    applyLayoutOverrides(candidate.plan, candidate.layoutOverrides),
    candidate.customLayouts
  );
}

export function activeStudioTake(
  candidates: readonly ScriptMangaPlanCandidateView[],
  studio: NameStudioState
): ScriptMangaPlanCandidateView | null {
  if (candidates.length === 0) return null;
  return candidates.find((candidate) => candidate.id === studio.takeId) ?? candidates[0]!;
}

function panelDialogueStats(panel: ScriptMangaPanelPlan, dialogueChars: number[]): { count: number; chars: number } {
  return {
    count: panel.dialogueOrderIndexes.length,
    chars: panel.dialogueOrderIndexes.reduce((sum, orderIndex) => sum + (dialogueChars[orderIndex] ?? 0), 0)
  };
}

/** ページのコマ要求(フリップ候補の計算に使う。サーバー側 set-layout 検証と同一関数)。 */
function pageDemands(page: ScriptMangaPagePlan, dialogueChars: number[]) {
  return page.panels.map((panel) => {
    const stats = panelDialogueStats(panel, dialogueChars);
    return buildPanelDemand({
      visualScale: panel.visualScale,
      totalCharacters: stats.chars,
      balloonCount: stats.count
    });
  });
}

function reasonsText(entry: RankedLayout): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const reason of entry.reasons) {
    const label = REASON_LABELS[reason.code];
    if (label && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.join(" / ");
}

function candidateBadges(candidate: ScriptMangaPlanCandidateView): string {
  const mode = candidate.pageNaming?.mode ?? null;
  const badges: string[] = [];
  if (mode === "beats") {
    const annotatorNote = candidate.pageNaming?.beatAnnotatorFallback ? "(注釈fallback)" : "";
    badges.push(`<span class="plan-candidate-badge is-beats">ビート化N1${annotatorNote}</span>`);
  } else if (mode === "deterministic") {
    badges.push(`<span class="plan-candidate-badge is-deterministic">決定的</span>`);
  }
  if (candidate.profile) badges.push(`<span class="plan-candidate-badge is-profile">${escapeHtml(candidate.profile)}</span>`);
  if (typeof candidate.temperature === "number") badges.push(`<span class="plan-candidate-badge is-temp">T=${candidate.temperature}</span>`);
  if (candidate.status === "adopted") badges.push(`<span class="plan-candidate-badge is-adopted-badge">採用済み</span>`);
  if (candidate.status === "adopting") badges.push(`<span class="plan-candidate-badge is-adopted-badge">採用中…</span>`);
  if (Object.keys(candidate.layoutOverrides).length > 0) {
    badges.push(`<span class="plan-candidate-badge is-flipped">フリップ済み</span>`);
  }
  return badges.join("");
}

/**
 * 完全に同じ構造の候補は比較案として水増ししない。
 * deep link等で重複側が選択済みなら、そのcandidateをgroupの代表として残す。
 */
export function distinctNameStudioCandidates(
  candidates: readonly ScriptMangaPlanCandidateView[],
  selectedId: string | null
): ScriptMangaPlanCandidateView[] {
  const groups = new Map<string, ScriptMangaPlanCandidateView>();
  const priority = (candidate: ScriptMangaPlanCandidateView): number => {
    if (candidate.status === "adopted") return 5;
    if (candidate.status === "adopting") return 4;
    if (candidate.id === selectedId) return 3;
    if (Object.keys(candidate.layoutOverrides).length > 0) return 1;
    return 0;
  };
  for (const candidate of candidates) {
    // 構造署名は customLayouts/balloonHints(人間のコマ割り修正)を含まないため、署名へ併記する。
    // 含めないと「人間が修正した候補」が未修正の同構造候補と同一視され一覧から隠される。
    const customLayouts = candidate.customLayouts && Object.keys(candidate.customLayouts).length > 0
      ? `|cl:${JSON.stringify(candidate.customLayouts)}`
      : "";
    const balloonHints = candidate.balloonHints && Object.keys(candidate.balloonHints).length > 0
      ? `|bh:${JSON.stringify(candidate.balloonHints)}`
      : "";
    const signature = candidatePlanStructureSignature(candidate) + customLayouts + balloonHints;
    const current = groups.get(signature);
    if (!current || priority(candidate) > priority(current)) groups.set(signature, candidate);
  }
  return [...groups.values()];
}

function takeSummary(candidate: ScriptMangaPlanCandidateView): string {
  const plan = effectiveCandidatePlan(candidate);
  const larges = plan.pages.reduce((sum, page) => sum + page.panels.filter((panel) => panel.visualScale === "large").length, 0);
  const splashes = plan.pages.reduce((sum, page) => sum + page.panels.filter((panel) => panel.visualScale === "splash").length, 0);
  const hooks = plan.pages.filter((page) => page.turnHook === "reveal" || page.turnHook === "cliffhanger").length;
  const avg = plan.pages.length > 0 ? (plan.panelCount / plan.pages.length).toFixed(1) : "0";
  return `${plan.pages.length}p / 平均${avg}コマ / 大 ${larges} / splash ${splashes} / hook ${hooks}`;
}

interface OverlayPlacement {
  style: string;
  compact: boolean;
  opensLeft: boolean;
  opensUp: boolean;
}

/** コマオーバーレイの配置と、小コマ用hover詳細の開く向きを同じbboxから決める。 */
function overlayPlacement(layout: PageLayout, slotIndex: number): OverlayPlacement | null {
  const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const slot = ordered[slotIndex];
  if (!slot) return null;
  const [x1, y1, x2, y2] = panelBounds(slot.shape);
  const pageHeight = layout.page.height;
  const left = Math.max(0, Math.min(1, x1));
  const right = Math.max(0, Math.min(1, x2));
  const top = Math.max(0, Math.min(pageHeight, y1));
  const bottom = Math.max(0, Math.min(pageHeight, y2));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width <= 0 || height <= 0) return null;
  const relativeHeight = height / pageHeight;
  const relativeArea = width * relativeHeight;
  return {
    style: `left:${(left * 100).toFixed(2)}%;top:${(top / pageHeight * 100).toFixed(2)}%;width:${(width * 100).toFixed(2)}%;height:${(relativeHeight * 100).toFixed(2)}%;`,
    compact: width < 0.34 || relativeHeight < 0.2 || relativeArea < 0.11,
    opensLeft: left + width / 2 > 0.58,
    opensUp: top / pageHeight + relativeHeight / 2 > 0.68
  };
}

function candidateDialogueLines(panel: ScriptMangaPanelPlan, props: NameStudioViewProps): DialogueLine[] {
  const byOrder = new Map((props.dialogueLines ?? []).map((line) => [line.orderIndex, line]));
  return panel.dialogueOrderIndexes
    .map((orderIndex) => byOrder.get(orderIndex))
    .filter((line): line is DialogueLine => Boolean(line));
}

function dialogueBoxes(lines: readonly { speakerLabel?: string; text: string }[]): string {
  return lines.map((line) => `
    <span class="studio-panel-dialog-line">
      ${line.speakerLabel ? `<strong>${escapeHtml(line.speakerLabel)}</strong>` : ""}
      <span>${escapeHtml(line.text)}</span>
    </span>`).join("");
}

function candidateCamera(panel: ScriptMangaPanelPlan): string {
  if (!panel.direction) return "演出前";
  return [panel.direction.shot, panel.direction.angle].filter(Boolean).join(" / ");
}

function candidateContent(panel: ScriptMangaPanelPlan): string {
  return panel.direction?.action?.trim() || panel.sourceText;
}

function candidatePanelSummary(panel: ScriptMangaPanelPlan, lines: readonly DialogueLine[], clamp: boolean): string {
  const source = candidateContent(panel);
  const text = clamp && source.length > SOURCE_TEXT_CLAMP
    ? `${source.slice(0, SOURCE_TEXT_CLAMP)}…`
    : source;
  return `
    <span class="studio-panel-camera">カメラ: ${escapeHtml(candidateCamera(panel))}</span>
    <span class="studio-panel-text"><strong>見せる:</strong> ${escapeHtml(text)}</span>
    ${panel.direction?.composition
      ? `<span class="studio-panel-composition"><strong>構図:</strong> ${escapeHtml(panel.direction.composition)}</span>`
      : ""}
    ${lines.length > 0 ? `<span class="studio-panel-dialogues">${dialogueBoxes(lines)}</span>` : ""}`;
}

function panelOverlay(
  panel: ScriptMangaPanelPlan,
  slotIndex: number,
  layout: PageLayout,
  props: NameStudioViewProps
): string {
  const placement = overlayPlacement(layout, slotIndex);
  if (!placement) return "";
  const scale = panel.visualScale ?? "medium";
  const stats = panelDialogueStats(panel, props.dialogueChars);
  const kinds = (panel.sourceBeatIds ?? [])
    .map((beatId) => props.beatKinds[beatId])
    .filter((kind): kind is string => Boolean(kind));
  const kindChips = [...new Set(kinds)]
    .map((kind) => `<span class="studio-beat-chip is-${escapeAttr(kind)}">${escapeHtml(BEAT_KIND_LABELS[kind] ?? kind)}</span>`)
    .join("");
  const selected = props.nameStudio.selectedPanelId === panel.id;
  const lines = candidateDialogueLines(panel, props);
  const placementClasses = [
    placement.compact ? "is-compact-panel" : "",
    placement.opensLeft ? "opens-left" : "",
    placement.opensUp ? "opens-up" : ""
  ].filter(Boolean).join(" ");
  return `
    <button type="button" class="studio-panel is-${scale} ${selected ? "is-selected" : ""} ${placementClasses}"
      style="${placement.style}" data-action="studio-select-panel" data-id="${escapeAttr(panel.id)}"
      aria-haspopup="dialog" aria-label="コマ${slotIndex + 1}の詳細を開く">
      <span class="studio-panel-head">
        <span class="studio-panel-order">${slotIndex + 1}</span>
        <span class="studio-panel-scale">${SCALE_LABELS[scale]}${scale === "large" ? " ★" : ""}</span>
        ${kindChips}
      </span>
      <span class="studio-panel-inline">${candidatePanelSummary(panel, lines, true)}</span>
      ${lines.length === 0 && stats.count > 0 ? `<span class="studio-panel-dialogue-count">台詞 ${stats.count}件 / ${stats.chars}字</span>` : ""}
      ${placement.compact ? `<span class="studio-panel-compact-label">内容を見る</span>
        <span class="studio-panel-hover-card" aria-hidden="true">
          <strong>コマ${slotIndex + 1}</strong>${candidatePanelSummary(panel, lines, false)}
        </span>` : ""}
    </button>`;
}

/** ページ毎のレイアウトフリップ候補(diverse top-k、現在案を先頭に固定表示)。 */
function flipChips(
  candidate: ScriptMangaPlanCandidateView,
  plan: ScriptMangaPlan,
  page: ScriptMangaPagePlan,
  props: NameStudioViewProps
): string {
  if (candidate.status !== "active") return "";
  const demands = pageDemands(page, props.dialogueChars);
  const previousLayoutId = plan.pages[page.index - 1]?.layoutTemplateId;
  const ranked = feasibleLayouts(demands, { previousLayoutId });
  const alternatives = selectDiverseLayouts(ranked.filter((entry) => entry.layoutId !== page.layoutTemplateId), {
    count: FLIP_CHOICES
  });
  const current = ranked.find((entry) => entry.layoutId === page.layoutTemplateId);
  const overridden = candidate.layoutOverrides[page.index] !== undefined;
  const baseLayoutId = candidate.plan.pages.find((basePage) => basePage.index === page.index)?.layoutTemplateId;
  const chip = (entry: RankedLayout, isCurrent: boolean) => `
    <button type="button" class="studio-flip-chip ${isCurrent ? "is-current" : ""}"
      data-action="studio-flip-layout" data-id="${escapeAttr(candidate.id)}"
      data-page-index="${page.index}" data-layout-id="${escapeAttr(entry.layoutId)}"
      title="${escapeAttr(reasonsText(entry))}" ${isCurrent ? "disabled" : ""}>
      ${isCurrent ? "◆" : "◇"} ${escapeHtml(entry.layoutId.replace(/^builtin:/, ""))}
    </button>`;
  const resetChip = overridden && baseLayoutId
    ? `<button type="button" class="studio-flip-chip is-reset" data-action="studio-flip-layout"
        data-id="${escapeAttr(candidate.id)}" data-page-index="${page.index}"
        data-layout-id="${escapeAttr(baseLayoutId)}" title="LLMの元の案へ戻す">元の案に戻す</button>`
    : "";
  const reasonNote = current ? `<span class="studio-flip-reasons">${escapeHtml(reasonsText(current))}</span>` : "";
  return `
    <div class="studio-flips">
      <span class="studio-flips-label">レイアウト:</span>
      ${current ? chip(current, true) : ""}
      ${alternatives.map((entry) => chip(entry, false)).join("")}
      ${resetChip}
      ${reasonNote}
    </div>`;
}

function inspectorPanel(page: ScriptMangaPagePlan, props: NameStudioViewProps): string {
  const panel = page.panels.find((candidatePanel) => candidatePanel.id === props.nameStudio.selectedPanelId);
  if (!panel) {
    return `<p class="studio-inspector-hint">コマをクリックすると詳細を表示します。採用後はここで演出ネームを編集できます(P5)。</p>`;
  }
  const scale = panel.visualScale ?? "medium";
  const stats = panelDialogueStats(panel, props.dialogueChars);
  const lines = candidateDialogueLines(panel, props);
  const kinds = (panel.sourceBeatIds ?? [])
    .map((beatId) => props.beatKinds[beatId])
    .filter((kind): kind is string => Boolean(kind));
  return `
    <dl class="studio-inspector-list">
      <dt>サイズ</dt><dd>${SCALE_LABELS[scale]}</dd>
      <dt>ビート</dt><dd>${kinds.length > 0 ? escapeHtml([...new Set(kinds)].map((kind) => BEAT_KIND_LABELS[kind] ?? kind).join(" / ")) : "—"}</dd>
      <dt>シーン</dt><dd>${escapeHtml(panel.sceneHeading || "—")}</dd>
      <dt>カメラ</dt><dd>${escapeHtml(candidateCamera(panel))}</dd>
      <dt>内容</dt><dd class="studio-inspector-text">${escapeHtml(panel.sourceText)}</dd>
      <dt>台詞</dt><dd class="studio-inspector-text">${lines.length > 0
        ? dialogueBoxes(lines)
        : stats.count > 0 ? `${stats.count}件 / ${stats.chars}字` : "なし"}</dd>
    </dl>`;
}

// --- 演出ネーム(V5 D6): 採用後は run.plan(MangaPlanV2)を同じリーダーで表示・編集する ---

function dialogueTexts(panel: PanelSpec, plan: MangaPlanV2): string[] {
  return dialogueSnapshotsForPanel(panel, plan).map((line) => line.text);
}

function dialogueSnapshotsForPanel(panel: PanelSpec, plan: MangaPlanV2): MangaPlanV2["dialogueSnapshots"] {
  const byId = new Map(plan.dialogueSnapshots.map((line) => [line.id, line]));
  // 正は dialogueLineIds(orderIndexes は互換フィールド)。
  return panel.dialogueLineIds
    .map((lineId) => byId.get(lineId))
    .filter((line): line is MangaPlanV2["dialogueSnapshots"][number] => Boolean(line));
}

function entityName(plan: MangaPlanV2, entityId: string): string {
  return plan.narrativeGraph.entities.find((entity) => entity.id === entityId)?.name ?? entityId;
}

function directedPanelSummary(panel: PanelSpec, plan: MangaPlanV2, clamp: boolean): string {
  const camera = `${SHOT_SIZE_LABELS[panel.shot.size] ?? panel.shot.size} / ${panel.shot.angle}`;
  const composition = clamp && panel.shot.compositionIntent.length > SOURCE_TEXT_CLAMP
    ? `${panel.shot.compositionIntent.slice(0, SOURCE_TEXT_CLAMP)}…`
    : panel.shot.compositionIntent;
  const cast = panel.cast.map((member) =>
    `${entityName(plan, member.characterId)}: ${member.action} / ${member.expression}`
  );
  const lines = dialogueSnapshotsForPanel(panel, plan);
  return `
    <span class="studio-panel-camera">カメラ: ${escapeHtml(camera)}</span>
    <span class="studio-panel-text"><strong>見せる:</strong> ${escapeHtml(composition)}</span>
    ${cast.length > 0
      ? `<span class="studio-panel-cast"><strong>人物:</strong> ${escapeHtml(cast.join("\n"))}</span>`
      : ""}
    ${lines.length > 0 ? `<span class="studio-panel-dialogues">${dialogueBoxes(lines)}</span>` : ""}`;
}

function directedPanelOverlay(
  panel: PanelSpec,
  slotIndex: number,
  page: MangaPageSpec,
  plan: MangaPlanV2,
  props: NameStudioViewProps
): string {
  const placement = overlayPlacement(page.layoutSnapshot, slotIndex);
  if (!placement) return "";
  const scale = panel.visualScale ?? "medium";
  const selected = props.nameStudio.selectedPanelId === panel.id;
  const source = panel.directionSource ?? "llm";
  const placementClasses = [
    placement.compact ? "is-compact-panel" : "",
    placement.opensLeft ? "opens-left" : "",
    placement.opensUp ? "opens-up" : ""
  ].filter(Boolean).join(" ");
  return `
    <button type="button" class="studio-panel is-directed is-${scale} ${selected ? "is-selected" : ""} ${placementClasses} ${source === "fallback" ? "is-undirected" : ""}"
      style="${placement.style}" data-action="studio-select-panel" data-id="${escapeAttr(panel.id)}"
      aria-haspopup="dialog" aria-label="コマ${slotIndex + 1}の詳細を開く">
      <span class="studio-panel-head">
        <span class="studio-panel-order">${slotIndex + 1}</span>
        <span class="studio-panel-scale">${SCALE_LABELS[scale]}</span>
        <span class="studio-beat-chip is-source-${escapeAttr(source)}">${escapeHtml(DIRECTION_SOURCE_LABELS[source] ?? source)}</span>
      </span>
      <span class="studio-panel-inline">${directedPanelSummary(panel, plan, true)}</span>
      ${placement.compact ? `<span class="studio-panel-compact-label">内容を見る</span>
        <span class="studio-panel-hover-card" aria-hidden="true">
          <strong>コマ${slotIndex + 1}</strong>${directedPanelSummary(panel, plan, false)}
        </span>` : ""}
    </button>`;
}

function directedInspector(page: MangaPageSpec, plan: MangaPlanV2, props: NameStudioViewProps): string {
  const run = props.run!;
  const panel = page.panels.find((candidatePanel) => candidatePanel.id === props.nameStudio.selectedPanelId);
  if (!panel) {
    return `<p class="studio-inspector-hint">コマをクリックすると演出の詳細と編集フォームを表示します。</p>`;
  }
  const editable = directedPlanEditable(run);
  const draft = props.draft?.panelId === panel.id ? props.draft : null;
  if (!draft) {
    const dialogues = dialogueTexts(panel, plan);
    const source = panel.directionSource ?? "llm";
    return `
      <dl class="studio-inspector-list">
        <dt>演出</dt><dd>${escapeHtml(DIRECTION_SOURCE_LABELS[source] ?? source)}</dd>
        <dt>カメラ</dt><dd>${escapeHtml(`${SHOT_SIZE_LABELS[panel.shot.size] ?? panel.shot.size} / ${panel.shot.angle}`)}</dd>
        <dt>構図</dt><dd>${escapeHtml(panel.shot.compositionIntent)}</dd>
        <dt>人物</dt><dd>${panel.cast.length > 0
          ? escapeHtml(panel.cast.map((member) => `${entityName(plan, member.characterId)}: ${member.expression} / ${member.action}`).join("\n"))
          : "—"}</dd>
        <dt>台詞</dt><dd class="studio-inspector-text">${dialogues.length > 0 ? escapeHtml(dialogues.join("\n")) : "なし"}</dd>
        <dt>prompt</dt><dd class="studio-inspector-text">${escapeHtml(panel.promptBase)}</dd>
      </dl>
      ${editable
        ? `<button type="button" class="button-secondary compact" data-action="studio-edit-panel" data-id="${escapeAttr(panel.id)}">このコマを編集</button>`
        : `<p class="studio-inspector-hint">承認済み/実行中のプランは編集できません。</p>`}`;
  }
  // 編集フォーム: 値は常にドラフトからレンダーする(V5 D6、morphのフォーカス保護は1要素のみ)。
  const sizeOptions = Object.entries(SHOT_SIZE_LABELS)
    .map(([value, label]) => `<option value="${value}" ${draft.shotSize === value ? "selected" : ""}>${label}</option>`)
    .join("");
  const knownAngles = ["eye-level", "low", "high", "overhead", "dutch", "pov"];
  const angleOptions = [
    ...knownAngles.map((angle) => `<option value="${angle}" ${draft.shotAngle === angle ? "selected" : ""}>${angle}</option>`),
    // V2のangleは自由string: 既知6値以外の現値は「その他(現値保持)」として温存する。
    ...(knownAngles.includes(draft.shotAngle)
      ? []
      : [`<option value="${escapeAttr(draft.shotAngle)}" selected>その他(${escapeHtml(draft.shotAngle)})</option>`])
  ].join("");
  const castRows = draft.cast.map((member) => `
    <div class="studio-edit-cast-row" data-character-id="${escapeAttr(member.characterId)}">
      <span class="studio-edit-cast-name">${escapeHtml(member.name)}</span>
      <input type="text" data-studio-edit="cast-expression" data-character-id="${escapeAttr(member.characterId)}"
        value="${escapeAttr(member.expression)}" placeholder="表情" />
      <input type="text" data-studio-edit="cast-action" data-character-id="${escapeAttr(member.characterId)}"
        value="${escapeAttr(member.action)}" placeholder="行動" />
    </div>`).join("");
  return `
    <div class="studio-edit-form">
      <label class="studio-edit-field"><span>カメラ(size)</span>
        <select data-studio-edit="shotSize">${sizeOptions}</select></label>
      <label class="studio-edit-field"><span>カメラ(angle)</span>
        <select data-studio-edit="shotAngle">${angleOptions}</select></label>
      <label class="studio-edit-field"><span>構図</span>
        <input type="text" data-studio-edit="compositionIntent" value="${escapeAttr(draft.compositionIntent)}" /></label>
      <label class="studio-edit-field"><span>prompt(英語の視覚事実)</span>
        <textarea data-studio-edit="promptBase" rows="4">${escapeHtml(draft.promptBase)}</textarea></label>
      ${castRows ? `<div class="studio-edit-field"><span>人物(表情 / 行動)</span>${castRows}</div>` : ""}
      <label class="studio-edit-field"><span>ページ意図</span>
        <input type="text" data-studio-edit="pageIntent" value="${escapeAttr(draft.pageIntent)}" /></label>
      <div class="studio-actions">
        <button type="button" class="button-primary compact" data-action="studio-save-edits" ${props.runBusy ? "disabled" : ""}>保存(再構成)</button>
        <button type="button" class="button-secondary compact" data-action="studio-cancel-edits">取消</button>
      </div>
      <p class="studio-inspector-hint">保存すると監督済みプランへ差分適用され、runは再承認待ちへ戻ります。</p>
    </div>`;
}

function panelDialogShell(panelId: string, title: string, subtitle: string, body: string): string {
  return `
    <div class="studio-panel-dialog-backdrop">
      <section class="studio-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-panel-dialog-title">
        <header class="studio-panel-dialog-header">
          <div>
            <span class="studio-panel-dialog-kicker">${escapeHtml(subtitle)}</span>
            <h3 id="studio-panel-dialog-title">${escapeHtml(title)}</h3>
          </div>
          <button type="button" class="studio-panel-dialog-close" data-action="studio-close-panel"
            data-id="${escapeAttr(panelId)}" aria-label="コマ詳細を閉じる">×</button>
        </header>
        <div class="studio-panel-dialog-body">${body}</div>
      </section>
    </div>`;
}

function candidatePanelDialog(page: ScriptMangaPagePlan, props: NameStudioViewProps): string {
  const panelIndex = page.panels.findIndex((panel) => panel.id === props.nameStudio.selectedPanelId);
  const panel = page.panels[panelIndex];
  if (!panel) return "";
  const lines = candidateDialogueLines(panel, props);
  const kinds = (panel.sourceBeatIds ?? [])
    .map((beatId) => props.beatKinds[beatId])
    .filter((kind): kind is string => Boolean(kind));
  return panelDialogShell(
    panel.id,
    `コマ ${panelIndex + 1}`,
    `${panel.sceneHeading || "シーン未設定"} / ${SCALE_LABELS[panel.visualScale ?? "medium"]}`,
    `<div class="studio-panel-dialog-storyboard">
      ${candidatePanelSummary(panel, lines, false)}
    </div>
    <dl class="studio-panel-dialog-meta">
      <dt>ビート</dt><dd>${kinds.length > 0
        ? escapeHtml([...new Set(kinds)].map((kind) => BEAT_KIND_LABELS[kind] ?? kind).join(" / "))
        : "—"}</dd>
      <dt>脚本要素</dt><dd>${escapeHtml(panel.sourceText)}</dd>
      <dt>台詞順</dt><dd>${panel.dialogueOrderIndexes.length > 0
        ? panel.dialogueOrderIndexes.join(" → ")
        : "なし"}</dd>
    </dl>`
  );
}

function directedPanelDialog(page: MangaPageSpec, plan: MangaPlanV2, props: NameStudioViewProps): string {
  const panelIndex = page.panels.findIndex((panel) => panel.id === props.nameStudio.selectedPanelId);
  const panel = page.panels[panelIndex];
  if (!panel) return "";
  const source = panel.directionSource ?? "llm";
  return panelDialogShell(
    panel.id,
    `コマ ${panelIndex + 1}`,
    `${DIRECTION_SOURCE_LABELS[source] ?? source} / ${SCALE_LABELS[panel.visualScale ?? "medium"]}`,
    `<div class="studio-panel-dialog-storyboard">
      ${directedPanelSummary(panel, plan, false)}
    </div>
    <details class="studio-panel-dialog-prompt">
      <summary>画像promptを確認</summary>
      <p>${escapeHtml(panel.promptBase)}</p>
    </details>`
  );
}

function studioReaderState<T>(pages: T[], studio: NameStudioState) {
  const settings = nameStudioReaderSettings(studio);
  const pageIndex = canonicalReaderIndex(studio.pageIndex, pages.length, settings);
  const visible = getVisibleReaderPages(pages, pageIndex, settings);
  return {
    pageIndex,
    visible,
    label: readerPageLabel(visible, pages.length),
    canGoPrevious: goPrevReaderIndex(pageIndex, pages.length, settings) !== pageIndex,
    canGoNext: goNextReaderIndex(pageIndex, pages.length, settings) !== pageIndex
  };
}

function renderStudioPageStage<T>(
  visible: VisibleReaderPage<T>[],
  studio: NameStudioState,
  renderPage: (entry: VisibleReaderPage<T>) => string
): string {
  const unpaired = studio.layout === "spread" && visible.length === 1;
  return `
    <div class="studio-page-stage ${studio.layout} ${studio.fitMode} ${unpaired ? "is-unpaired" : ""}">
      <div class="studio-page-strip">
        ${visible.map((entry) => renderPage(entry)).join(visible.length === 2
          ? `<div class="studio-page-gutter" aria-hidden="true"></div>`
          : "")}
      </div>
    </div>`;
}

function renderDirectedPage(
  entry: VisibleReaderPage<MangaPageSpec>,
  plan: MangaPlanV2,
  props: NameStudioViewProps
): string {
  const page = entry.page;
  const wireframePanels: WireframePanelInfo[] = page.panels.map((panel) => ({ visualScale: panel.visualScale }));
  const svg = renderPageWireframeSvg(page.layoutSnapshot, {
    className: "studio-page-svg",
    panels: wireframePanels,
    turnHook: page.turnHook
  });
  // ポーズ編集ステージ: コマのHTMLオーバーレイを外し、骨格SVGだけを操作可能に重ねる。
  const poseEditActive = props.poseEdit && props.poseEdit.pageIndex === page.index;
  if (poseEditActive) {
    return `
    <div class="studio-page-sheet is-pose-edit" data-page-number="${entry.pageNumber}">
      <span class="studio-page-sheet-number">p${entry.pageNumber}</span>
      <div class="studio-page" style="aspect-ratio: 1 / ${page.layoutSnapshot.page.height.toFixed(6)};">
        ${svg}
        <div class="studio-pose-layer is-editing">${renderNamePoseOverlaySvg(page, plan, props.poseEdit)}</div>
      </div>
      ${renderNamePoseEditToolbar(props.poseEdit!, plan)}
    </div>`;
  }
  const showPoseLayer = props.nameStudio.showPoseLayer !== false &&
    page.panels.some((panel) => (panel.castPoses?.length ?? 0) > 0);
  const overlays = page.panels
    .map((panel, slotIndex) => directedPanelOverlay(panel, slotIndex, page, plan, props))
    .join("");
  return `
    <div class="studio-page-sheet" data-page-number="${entry.pageNumber}">
      <span class="studio-page-sheet-number">p${entry.pageNumber}</span>
      <div class="studio-page" style="aspect-ratio: 1 / ${page.layoutSnapshot.page.height.toFixed(6)};">
        ${svg}
        ${showPoseLayer ? `<div class="studio-pose-layer">${renderNamePoseOverlaySvg(page, plan)}</div>` : ""}
        <div class="studio-overlays">${overlays}</div>
      </div>
    </div>`;
}

function renderDirectedReader(props: NameStudioViewProps): string {
  const run = props.run!;
  const plan = run.plan!;
  const pageCount = plan.pages.length;
  const reader = studioReaderState(plan.pages, props.nameStudio);
  if (reader.visible.length === 0) return `<p class="studio-inspector-hint">プランにページがありません。</p>`;
  return `
    <div class="studio-reader">
      <div class="studio-page-nav">
        <button type="button" class="button-secondary compact" data-action="studio-prev-page"
          aria-keyshortcuts="ArrowLeft" title="前へ (←)" ${reader.canGoPrevious ? "" : "disabled"}>◀ 前ページ</button>
        <span class="studio-page-counter">p${reader.label} <span class="studio-diff-note">演出ネーム(${escapeHtml(run.approvalStatus)})</span></span>
        <button type="button" class="button-secondary compact" data-action="studio-next-page"
          aria-keyshortcuts="ArrowRight" title="次へ (→)" ${reader.canGoNext ? "" : "disabled"}>次ページ ▶</button>
      </div>
      ${renderStudioPageStage(reader.visible, props.nameStudio, (entry) => renderDirectedPage(entry, plan, props))}
      <div class="studio-visible-page-meta">
        ${reader.visible.map(({ page, pageNumber }) => {
          const turnHookLabel = page.turnHook === "reveal" ? "▼reveal" : page.turnHook === "cliffhanger" ? "▼cliffhanger" : "なし";
          const canEditPoses = directedPlanEditable(run) && !props.poseEdit &&
            page.panels.some((panel) => (panel.castPoses?.length ?? 0) > 0);
          return `<div class="studio-page-footer"><strong>p${pageNumber}</strong>
            <span class="studio-page-intent">ページ意図: ${escapeHtml(page.pageIntent?.trim() || "—")}</span>
            <span class="studio-page-hook">めくり: ${turnHookLabel}</span>
            ${canEditPoses ? `<button type="button" class="button-secondary compact" data-action="studio-edit-poses"
              data-page-index="${page.index}">ポーズ編集</button>` : ""}</div>`;
        }).join("")}
      </div>
    </div>`;
}

function renderCandidatePage(
  entry: VisibleReaderPage<ScriptMangaPagePlan>,
  candidate: ScriptMangaPlanCandidateView,
  props: NameStudioViewProps
): string {
  const page = entry.page;
  const edit = props.layoutEdit;
  if (edit && edit.candidateId === candidate.id && edit.pageIndex === page.index) {
    return `
    <div class="studio-page-sheet is-layout-edit" data-page-number="${entry.pageNumber}">
      <span class="studio-page-sheet-number">p${entry.pageNumber}</span>
      <div class="studio-page" style="aspect-ratio: 1 / ${edit.draftLayout.page.height.toFixed(6)};">
        ${renderNameLayoutEditSvg(edit, page, props.dialogueLines, LAYOUT_PAGE_MARGIN)}
      </div>
      ${renderNameLayoutEditToolbar(edit)}
    </div>`;
  }
  // 人間ゲートのコマ割り修正はテンプレ解決より優先(effectiveCandidatePlan が注釈済み)。
  const layout = page.customLayout ?? resolveScriptMangaLayout(page.layoutTemplateId);
  if (!layout) {
    return `<div class="studio-page-sheet is-error" data-page-number="${entry.pageNumber}">
      <p class="studio-inspector-hint">レイアウト ${escapeHtml(page.layoutTemplateId)} を解決できません。</p></div>`;
  }
  const wireframePanels: WireframePanelInfo[] = page.panels.map((panel) => ({
    visualScale: panel.visualScale,
    dialogueCharacters: panelDialogueStats(panel, props.dialogueChars).chars,
    beatKinds: (panel.sourceBeatIds ?? [])
      .map((beatId) => props.beatKinds[beatId])
      .filter((kind): kind is string => Boolean(kind))
  }));
  const svg = renderPageWireframeSvg(layout, {
    className: "studio-page-svg",
    panels: wireframePanels,
    turnHook: page.turnHook
  });
  const overlays = page.panels
    .map((panel, slotIndex) => panelOverlay(panel, slotIndex, layout, props))
    .join("");
  return `
    <div class="studio-page-sheet" data-page-number="${entry.pageNumber}">
      <span class="studio-page-sheet-number">p${entry.pageNumber}</span>
      <div class="studio-page" style="aspect-ratio: 1 / ${layout.page.height.toFixed(6)};">
        ${svg}
        <div class="studio-overlays">${overlays}</div>
      </div>
    </div>`;
}

function renderReader(candidate: ScriptMangaPlanCandidateView, props: NameStudioViewProps): string {
  const plan = effectiveCandidatePlan(candidate);
  const pageCount = plan.pages.length;
  const reader = studioReaderState(plan.pages, props.nameStudio);
  if (reader.visible.length === 0) return `<p class="studio-inspector-hint">この候補にはページがありません。</p>`;
  // diff署名はビート/element基準なのでフリップでは変化しない(基礎プランで判定してよい)。
  const diff = candidateDiffSignatures(props.candidates);
  const isDiffPage = reader.visible.some(({ page }) => diff.has(candidatePageSignature(page)));
  const adoptDisabled = props.runBusy || !props.templateSelected || candidate.status !== "active";
  const takeIndex = Math.max(0, props.candidates.findIndex((entry) => entry.id === candidate.id));
  const comparisonNote = props.candidates.length >= 2 && isDiffPage
    ? `<span class="studio-diff-note">この頁は候補間で異なる</span>`
    : "";
  return `
    <div class="studio-reader">
      <div class="studio-page-nav">
        <button type="button" class="button-secondary compact" data-action="studio-prev-page"
          aria-keyshortcuts="ArrowLeft" title="前へ (←)" ${reader.canGoPrevious ? "" : "disabled"}>◀ 前ページ</button>
        <span class="studio-page-counter"><strong>${takeLabel(takeIndex)}</strong> · p${reader.label}${comparisonNote}</span>
        <button type="button" class="button-secondary compact" data-action="studio-next-page"
          aria-keyshortcuts="ArrowRight" title="次へ (→)" ${reader.canGoNext ? "" : "disabled"}>次ページ ▶</button>
      </div>
      ${renderStudioPageStage(reader.visible, props.nameStudio, (entry) => renderCandidatePage(entry, candidate, props))}
      <div class="studio-visible-page-meta">
        ${reader.visible.map(({ page, pageNumber }) => {
          const turnHookLabel = page.turnHook === "reveal" ? "▼reveal" : page.turnHook === "cliffhanger" ? "▼cliffhanger" : "なし";
          const customized = Boolean(candidate.customLayouts?.[page.index]) || Boolean(candidate.balloonHints?.[page.index]);
          const editButton = candidate.status === "active"
            ? `<button type="button" class="studio-flip-chip is-edit-layout" data-action="studio-edit-layout"
                data-id="${escapeAttr(candidate.id)}" data-page-index="${page.index}"
                title="辺・頂点・交差点・余白・裁ち切り・吹き出し位置をドラッグで修正">
                ✎ コマ割りを修正${customized ? "(修正済み)" : ""}</button>`
            : customized ? `<span class="plan-candidate-badge is-flipped">コマ割り修正済み</span>` : "";
          return `<div class="studio-page-tools"><div class="studio-page-footer"><strong>p${pageNumber}</strong>
            <span class="studio-page-intent">ページ意図: ${escapeHtml(page.pageIntent?.trim() || "—")}</span>
            <span class="studio-page-hook">めくり: ${turnHookLabel}</span></div>
            ${flipChips(candidate, plan, page, props)}
            ${editButton}</div>`;
        }).join("")}
      </div>
      <div class="studio-actions">
        <button type="button" class="button-primary" data-action="adopt-script-manga-plan-candidate"
          data-id="${escapeAttr(candidate.id)}" ${adoptDisabled ? "disabled" : ""}
          title="修正済みコマ割りを含む実効プランで検査(full preflight)が走り、通過するとエージェントの生成フローへ進みます">このネームで生成</button>
        <button type="button" class="button-secondary" data-action="archive-script-manga-plan-candidate"
          data-id="${escapeAttr(candidate.id)}" ${props.candidatesBusy ? "disabled" : ""}>破棄</button>
        ${!props.templateSelected ? `<span class="studio-inspector-hint">採用には workflow template の選択が必要です。</span>` : ""}
      </div>
    </div>`;
}

export function renderNameStudio(props: NameStudioViewProps): string {
  const countOptions = [1, 2, 3, 4, 5, 6]
    .map((count) => `<option value="${count}" ${count === props.candidateCount ? "selected" : ""}>${count}</option>`)
    .join("");
  const directedAvailable = Boolean(props.run?.plan);
  const isDirected = directedAvailable && props.nameStudio.takeId === DIRECTED_TAKE_ID;
  const visibleCandidates = distinctNameStudioCandidates(props.candidates, props.nameStudio.takeId);
  const hiddenDuplicateCount = props.candidates.length - visibleCandidates.length;
  const visibleProps: NameStudioViewProps = { ...props, candidates: visibleCandidates };
  const active = isDirected ? null : activeStudioTake(visibleCandidates, props.nameStudio);
  const directedPlan = isDirected ? props.run!.plan! : null;
  const directedPrimaryPage = directedPlan
    ? directedPlan.pages[canonicalReaderIndex(
        props.nameStudio.pageIndex,
        directedPlan.pages.length,
        nameStudioReaderSettings(props.nameStudio)
      )]
    : null;
  const directedDetailPage = directedPlan && props.nameStudio.selectedPanelId
    ? directedPlan.pages.find((page) => page.panels.some((panel) => panel.id === props.nameStudio.selectedPanelId))
        ?? directedPrimaryPage
    : directedPrimaryPage;
  const activePlan = active ? effectiveCandidatePlan(active) : null;
  const activePrimaryPage = activePlan
    ? activePlan.pages[canonicalReaderIndex(
        props.nameStudio.pageIndex,
        activePlan.pages.length,
        nameStudioReaderSettings(props.nameStudio)
      )] ?? activePlan.pages[0]
    : null;
  const activeDetailPage = activePlan && props.nameStudio.selectedPanelId
    ? activePlan.pages.find((page) => page.panels.some((panel) => panel.id === props.nameStudio.selectedPanelId))
        ?? activePrimaryPage
    : activePrimaryPage;
  const panelDialog = directedDetailPage
    ? directedPanelDialog(directedDetailPage, props.run!.plan!, props)
    : activeDetailPage ? candidatePanelDialog(activeDetailPage, props) : "";
  const directedChip = directedAvailable ? `
    <button type="button" class="studio-take is-directed-take ${isDirected ? "is-active" : ""}"
      role="tab" aria-selected="${isDirected ? "true" : "false"}"
      data-action="studio-select-take" data-id="${DIRECTED_TAKE_ID}">
      <span class="studio-take-label">演出ネーム</span>
      <span class="studio-take-badges"><span class="plan-candidate-badge is-beats">採用済みプラン</span></span>
      <span class="studio-take-summary">${props.run!.plan!.pages.length}p / カメラ・人物・台詞本文${directedPlanEditable(props.run!) ? " / 編集可" : ""}</span>
    </button>` : "";
  const takes = directedChip + visibleCandidates.map((candidate, index) => `
    <button type="button" class="studio-take ${candidate.id === active?.id ? "is-active" : ""} ${candidate.status === "adopted" ? "is-adopted" : ""}"
      role="tab" aria-selected="${candidate.id === active?.id ? "true" : "false"}"
      data-action="studio-select-take" data-id="${escapeAttr(candidate.id)}">
      <span class="studio-take-label">${takeLabel(index)}</span>
      <span class="studio-take-badges">${candidateBadges(candidate)}</span>
      <span class="studio-take-summary">${escapeHtml(takeSummary(candidate))}</span>
    </button>`).join("");
  return `
    <section class="name-studio-card ${props.nameStudio.fullscreen ? "is-fullscreen" : ""} is-${props.nameStudio.layout} is-${props.nameStudio.fitMode}"
      data-key="name-studio" aria-labelledby="name-studio-heading" aria-keyshortcuts="ArrowLeft ArrowRight Home End">
      <div class="name-studio-heading">
        <h2 id="name-studio-heading">ネームスタジオ<span class="tag">name studio</span></h2>
        <div class="name-studio-controls">
          <label class="studio-count-label">候補数
            <select data-script-manga-candidate-count ${props.candidatesBusy ? "disabled" : ""}>${countOptions}</select>
          </label>
          <button type="button" class="button-secondary compact" data-action="generate-script-manga-plan-candidates"
            ${props.candidatesBusy || !props.activeScriptId ? "disabled" : ""}>${props.candidatesBusy ? "生成中…" : "候補を生成"}</button>
          ${active ? `<button type="button" class="button-secondary compact" data-action="extend-script-manga-plan-candidates"
            data-group-id="${escapeAttr(active.groupId)}" ${props.candidatesBusy ? "disabled" : ""}>追加生成</button>` : ""}
          <div class="studio-reader-options" role="group" aria-label="ページ表示">
            <button type="button" class="${props.nameStudio.layout === "single" ? "button-primary" : "button-secondary"} compact"
              data-action="studio-set-layout" data-id="single" aria-pressed="${props.nameStudio.layout === "single"}">1ページ</button>
            <button type="button" class="${props.nameStudio.layout === "spread" ? "button-primary" : "button-secondary"} compact"
              data-action="studio-set-layout" data-id="spread" aria-pressed="${props.nameStudio.layout === "spread"}">2ページ</button>
          </div>
          <div class="studio-reader-options" role="group" aria-label="ページのフィット方法">
            <button type="button" class="${props.nameStudio.fitMode === "fit-height" ? "button-primary" : "button-secondary"} compact"
              data-action="studio-set-fit" data-id="fit-height" aria-pressed="${props.nameStudio.fitMode === "fit-height"}">高さ合わせ</button>
            <button type="button" class="${props.nameStudio.fitMode === "fit-width" ? "button-primary" : "button-secondary"} compact"
              data-action="studio-set-fit" data-id="fit-width" aria-pressed="${props.nameStudio.fitMode === "fit-width"}">横幅合わせ</button>
          </div>
          ${isDirected ? `<button type="button" class="${props.nameStudio.showPoseLayer !== false ? "button-primary" : "button-secondary"} compact"
            data-action="studio-toggle-pose-layer" aria-pressed="${props.nameStudio.showPoseLayer !== false}"
            title="キャラ骨格レイヤの表示切替">ポーズ</button>` : ""}
          <button type="button" class="button-secondary compact" data-action="studio-toggle-fullscreen"
            aria-pressed="${props.nameStudio.fullscreen ? "true" : "false"}">${props.nameStudio.fullscreen ? "元の表示へ" : "⛶ 全画面"}</button>
        </div>
      </div>
      ${props.candidates.length === 0 && !directedAvailable
        ? `<p class="studio-inspector-hint">${props.candidatesBusy
            ? "候補を生成しています…(ビート注釈は revision 単位でキャッシュされます)"
            : "「候補を生成」でコマ割り候補(テイク)を作り、ネームとして読み比べて採用します。エージェントがAPIで作った候補もここへ自動で現れます。"}</p>`
        : `
      <div class="name-studio-takes" role="tablist">${takes}</div>
      ${hiddenDuplicateCount > 0 ? `<p class="studio-duplicate-summary">重複する候補 ${hiddenDuplicateCount}件は比較案から省略しました。</p>` : ""}
      <p class="studio-take-legend">テイクA/B/Cは話の区切り・ページ送り案です。ページ下の◆レイアウトは、同じページ内の構図案です。</p>
      <div class="name-studio-body">
        ${isDirected ? renderDirectedReader(visibleProps) : active ? renderReader(active, visibleProps) : ""}
        <aside class="name-studio-inspector">
          <h3>コマ詳細</h3>
          ${isDirected
            ? directedDetailPage ? directedInspector(
                directedDetailPage,
                props.run!.plan!,
                props
              ) : `<p class="studio-inspector-hint">表示できるページがありません。</p>`
            : active && activeDetailPage
              ? inspectorPanel(activeDetailPage, props)
              : ""}
        </aside>
      </div>`}
      ${panelDialog}
    </section>`;
}
