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
  applyLayoutOverrides,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelPlan,
  type ScriptMangaPlan
} from "../../shared/scriptMangaPlan";
import type { ScriptMangaPlanCandidateView } from "../../shared/scriptMangaApi";
import type { NameStudioState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { candidateDiffSignatures, candidatePageSignature } from "./scriptView";

export interface NameStudioViewProps {
  activeScriptId: string | null;
  candidates: ScriptMangaPlanCandidateView[];
  beatKinds: Record<string, string>;
  dialogueChars: number[];
  candidatesBusy: boolean;
  runBusy: boolean;
  candidateCount: number;
  templateSelected: boolean;
  nameStudio: NameStudioState;
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

export function takeLabel(index: number): string {
  return `テイク${String.fromCharCode(65 + (index % 26))}`;
}

/** 表示・採用に使う実効プラン(基礎プラン+人間のフリップ)。 */
export function effectiveCandidatePlan(candidate: ScriptMangaPlanCandidateView): ScriptMangaPlan {
  return applyLayoutOverrides(candidate.plan, candidate.layoutOverrides);
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

function takeSummary(candidate: ScriptMangaPlanCandidateView): string {
  const plan = effectiveCandidatePlan(candidate);
  const larges = plan.pages.reduce((sum, page) => sum + page.panels.filter((panel) => panel.visualScale === "large").length, 0);
  const splashes = plan.pages.reduce((sum, page) => sum + page.panels.filter((panel) => panel.visualScale === "splash").length, 0);
  const hooks = plan.pages.filter((page) => page.turnHook === "reveal" || page.turnHook === "cliffhanger").length;
  const avg = plan.pages.length > 0 ? (plan.panelCount / plan.pages.length).toFixed(1) : "0";
  return `${plan.pages.length}p / 平均${avg}コマ / 大 ${larges} / splash ${splashes} / hook ${hooks}`;
}

/** コマオーバーレイの配置スタイル(bboxを%へ。yはpage.heightで割る。bleedはページ矩形へクランプ)。 */
function overlayStyle(layout: PageLayout, slotIndex: number): string | null {
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
  return `left:${(left * 100).toFixed(2)}%;top:${(top / pageHeight * 100).toFixed(2)}%;width:${(width * 100).toFixed(2)}%;height:${(height / pageHeight * 100).toFixed(2)}%;`;
}

function panelOverlay(
  panel: ScriptMangaPanelPlan,
  slotIndex: number,
  layout: PageLayout,
  props: NameStudioViewProps
): string {
  const style = overlayStyle(layout, slotIndex);
  if (!style) return "";
  const scale = panel.visualScale ?? "medium";
  const stats = panelDialogueStats(panel, props.dialogueChars);
  const kinds = (panel.sourceBeatIds ?? [])
    .map((beatId) => props.beatKinds[beatId])
    .filter((kind): kind is string => Boolean(kind));
  const kindChips = [...new Set(kinds)]
    .map((kind) => `<span class="studio-beat-chip is-${escapeAttr(kind)}">${escapeHtml(BEAT_KIND_LABELS[kind] ?? kind)}</span>`)
    .join("");
  const selected = props.nameStudio.selectedPanelId === panel.id;
  const text = panel.sourceText.length > SOURCE_TEXT_CLAMP
    ? `${panel.sourceText.slice(0, SOURCE_TEXT_CLAMP)}…`
    : panel.sourceText;
  return `
    <button type="button" class="studio-panel is-${scale} ${selected ? "is-selected" : ""}"
      style="${style}" data-action="studio-select-panel" data-id="${escapeAttr(panel.id)}">
      <span class="studio-panel-head">
        <span class="studio-panel-order">${slotIndex + 1}</span>
        <span class="studio-panel-scale">${SCALE_LABELS[scale]}${scale === "large" ? " ★" : ""}</span>
        ${kindChips}
      </span>
      <span class="studio-panel-text">${escapeHtml(text)}</span>
      ${stats.count > 0 ? `<span class="studio-panel-dialogue">台詞 ${stats.count}件 / ${stats.chars}字</span>` : ""}
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
  const kinds = (panel.sourceBeatIds ?? [])
    .map((beatId) => props.beatKinds[beatId])
    .filter((kind): kind is string => Boolean(kind));
  return `
    <dl class="studio-inspector-list">
      <dt>サイズ</dt><dd>${SCALE_LABELS[scale]}</dd>
      <dt>ビート</dt><dd>${kinds.length > 0 ? escapeHtml([...new Set(kinds)].map((kind) => BEAT_KIND_LABELS[kind] ?? kind).join(" / ")) : "—"}</dd>
      <dt>シーン</dt><dd>${escapeHtml(panel.sceneHeading || "—")}</dd>
      <dt>内容</dt><dd class="studio-inspector-text">${escapeHtml(panel.sourceText)}</dd>
      <dt>台詞</dt><dd>${stats.count > 0 ? `${stats.count}件 / ${stats.chars}字` : "なし"}</dd>
    </dl>`;
}

function renderReader(candidate: ScriptMangaPlanCandidateView, props: NameStudioViewProps): string {
  const plan = effectiveCandidatePlan(candidate);
  const pageCount = plan.pages.length;
  const pageIndex = Math.max(0, Math.min(pageCount - 1, props.nameStudio.pageIndex));
  const page = plan.pages[pageIndex];
  if (!page) return `<p class="studio-inspector-hint">この候補にはページがありません。</p>`;
  const layout = resolveScriptMangaLayout(page.layoutTemplateId);
  if (!layout) {
    return `<p class="studio-inspector-hint">レイアウト ${escapeHtml(page.layoutTemplateId)} を解決できません。</p>`;
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
  // diff署名はビート/element基準なのでフリップでは変化しない(基礎プランで判定してよい)。
  const diff = candidateDiffSignatures(props.candidates);
  const isDiffPage = diff.has(candidatePageSignature(page));
  const overlays = page.panels
    .map((panel, slotIndex) => panelOverlay(panel, slotIndex, layout, props))
    .join("");
  const turnHookLabel = page.turnHook === "reveal" ? "▼reveal" : page.turnHook === "cliffhanger" ? "▼cliffhanger" : "なし";
  const adoptDisabled = props.runBusy || !props.templateSelected || candidate.status !== "active";
  return `
    <div class="studio-reader">
      <div class="studio-page-nav">
        <button type="button" class="button-secondary compact" data-action="studio-prev-page" ${pageIndex <= 0 ? "disabled" : ""}>◀ 前ページ</button>
        <span class="studio-page-counter">p${pageIndex + 1} / ${pageCount}${isDiffPage ? `<span class="studio-diff-note">この頁は候補間で異なる</span>` : ""}</span>
        <button type="button" class="button-secondary compact" data-action="studio-next-page" ${pageIndex >= pageCount - 1 ? "disabled" : ""}>次ページ ▶</button>
      </div>
      <div class="studio-page" style="aspect-ratio: 1 / ${layout.page.height.toFixed(6)};">
        ${svg}
        <div class="studio-overlays">${overlays}</div>
      </div>
      ${flipChips(candidate, plan, page, props)}
      <div class="studio-page-footer">
        <span class="studio-page-intent">ページ意図: ${escapeHtml(page.pageIntent?.trim() || "—")}</span>
        <span class="studio-page-hook">めくり: ${turnHookLabel}</span>
      </div>
      <div class="studio-actions">
        <button type="button" class="button-primary" data-action="adopt-script-manga-plan-candidate"
          data-id="${escapeAttr(candidate.id)}" ${adoptDisabled ? "disabled" : ""}>この案で生成</button>
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
  const active = activeStudioTake(props.candidates, props.nameStudio);
  const takes = props.candidates.map((candidate, index) => `
    <button type="button" class="studio-take ${candidate.id === active?.id ? "is-active" : ""} ${candidate.status === "adopted" ? "is-adopted" : ""}"
      data-action="studio-select-take" data-id="${escapeAttr(candidate.id)}">
      <span class="studio-take-label">${takeLabel(index)}</span>
      <span class="studio-take-badges">${candidateBadges(candidate)}</span>
      <span class="studio-take-summary">${escapeHtml(takeSummary(candidate))}</span>
    </button>`).join("");
  return `
    <section class="name-studio-card" aria-labelledby="name-studio-heading">
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
        </div>
      </div>
      ${props.candidates.length === 0
        ? `<p class="studio-inspector-hint">${props.candidatesBusy
            ? "候補を生成しています…(ビート注釈は revision 単位でキャッシュされます)"
            : "「候補を生成」でコマ割り候補(テイク)を作り、ネームとして読み比べて採用します。エージェントがAPIで作った候補もここへ自動で現れます。"}</p>`
        : `
      <div class="name-studio-takes" role="tablist">${takes}</div>
      <div class="name-studio-body">
        ${active ? renderReader(active, props) : ""}
        <aside class="name-studio-inspector">
          <h3>コマ詳細</h3>
          ${active ? inspectorPanel(effectiveCandidatePlan(active).pages[Math.max(0, Math.min(effectiveCandidatePlan(active).pages.length - 1, props.nameStudio.pageIndex))] ?? effectiveCandidatePlan(active).pages[0]!, props) : ""}
        </aside>
      </div>`}
    </section>`;
}
