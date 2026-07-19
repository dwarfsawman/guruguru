/**
 * 脚本画面(Docs/Feature-ScriptToManga.md S3)。Book レベルの新スクリーン(bookSettingsView と同型、
 * book grid の上に重ねて表示)。Fountain 取り込み/再取り込み、シーン/セリフ一覧、キャラクタ管理、
 * セリフ行のページ割当を1画面にまとめる。state は引数で受け取るため main.ts への逆依存を持たない。
 */
import type {
  BookPages,
  Character,
  CharacterBindingView,
  DialogueLine,
  RecentReferenceImage,
  ScriptRevision,
  WorkflowTemplate
} from "../../shared/apiTypes";
import type { MangaScript } from "../../shared/apiTypes";
import type {
  ScriptMangaAuditMode,
  ScriptMangaPlanCandidateView,
  ScriptMangaRunView,
  ScriptMangaTaskView,
  ScriptMangaUiSettings,
  ScriptMangaVlmAuditView,
  VlmAuditServiceStatus
} from "../../shared/scriptMangaApi";
import {
  scriptMangaPlanStructureSignature as sharedPlanStructureSignature,
  type ScriptMangaPagePlan
} from "../../shared/scriptMangaPlan";
import { resolveScriptMangaLayout } from "../../shared/layoutPresets";
import { renderPageWireframeSvg, type WireframePanelInfo } from "../../shared/pageLayoutSvg";
import { escapeAttr, escapeHtml } from "../format";
import { iconPlus, iconScript, iconTrash } from "../icons";
import type { NameLayoutEditState, NamePoseEditState, NameStudioDraft, NameStudioState } from "../appState";
import { renderNameStudio } from "./nameStudioView";

const SEMANTIC_KIND_LABEL: Record<DialogueLine["semanticKind"], string> = {
  dialogue: "台詞",
  monologue: "心の声",
  narration: "ナレーション",
  sfx: "SFX"
};

export interface ScriptViewProps {
  book: BookPages;
  scripts: MangaScript[];
  activeScriptId: string | null;
  activeScriptRevision: ScriptRevision | null;
  dialogueLines: DialogueLine[];
  fountainDraft: string;
  importBusy: boolean;
  characters: Character[];
  selectedCharacterId: string | null;
  selectedCharacterBinding: CharacterBindingView | null;
  characterLoraNameDraft: string;
  characterLoraStrengthDraft: number;
  characterFacePickerOpen: boolean;
  recentImages: RecentReferenceImage[];
  loraChoices: string[];
  scriptMangaTemplates: WorkflowTemplate[];
  scriptMangaSettings: ScriptMangaUiSettings;
  scriptMangaRun: ScriptMangaRunView | null;
  scriptMangaBusy: boolean;
  scriptMangaVlmStatus: VlmAuditServiceStatus | null;
  scriptMangaCandidates: ScriptMangaPlanCandidateView[];
  scriptMangaCandidateBeatKinds: Record<string, string>;
  scriptMangaCandidateDialogueChars: number[];
  scriptMangaCandidatesBusy: boolean;
  scriptMangaCandidateCount: number;
  nameStudio: NameStudioState;
  nameStudioDraft: NameStudioDraft | null;
  nameLayoutEdit: NameLayoutEditState | null;
  namePoseEdit: NamePoseEditState | null;
}

export type ScriptMangaControlViewProps = Pick<
  ScriptViewProps,
  | "activeScriptId"
  | "activeScriptRevision"
  | "scriptMangaTemplates"
  | "scriptMangaSettings"
  | "scriptMangaRun"
  | "scriptMangaBusy"
  | "scriptMangaVlmStatus"
>;

export function renderScriptView(props: ScriptViewProps): string {
  const { book } = props;
  return `
    <main class="book-layout">
      <section class="panel">
        <div class="panel-heading">
          <div class="book-heading-copy">
            <div class="book-breadcrumb">
              <button class="button-secondary compact book-back-button" type="button" data-action="close-script-screen">← ページ一覧</button>
              <span class="book-page-label">${escapeHtml(book.project.name)}</span>
            </div>
            <h1>脚本<span class="tag">${iconScript()}script</span></h1>
            <p class="book-subtitle">Fountain 脚本を取り込むとキャラクター・セリフ一覧が作られます。再取り込みは既存の配置を維持したまま差分だけ反映します。</p>
          </div>
        </div>
        <div class="script-body">
          ${renderScriptTabs(props.scripts, props.activeScriptId)}
          ${renderImportCard(props)}
          ${props.activeScriptId && props.activeScriptRevision ? renderNameStudio({
            activeScriptId: props.activeScriptId,
            candidates: props.scriptMangaCandidates,
            beatKinds: props.scriptMangaCandidateBeatKinds,
            dialogueChars: props.scriptMangaCandidateDialogueChars,
            dialogueLines: props.dialogueLines,
            candidatesBusy: props.scriptMangaCandidatesBusy,
            runBusy: props.scriptMangaBusy,
            candidateCount: props.scriptMangaCandidateCount,
            templateSelected: Boolean(props.scriptMangaSettings.templateId),
            nameStudio: props.nameStudio,
            run: props.scriptMangaRun,
            draft: props.nameStudioDraft,
            layoutEdit: props.nameLayoutEdit,
            poseEdit: props.namePoseEdit
          }) : ""}
          ${renderScriptMangaControlCard(props)}
          <div class="script-columns">
            ${renderDialogueLinesPanel(props)}
            ${renderCharactersPanel(props)}
          </div>
        </div>
      </section>
    </main>
  `;
}

function unknownSummary(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderRunWarnings(run: ScriptMangaRunView): string {
  const warnings = [
    ...(run.validation?.issues ?? []).map((issue) => ({ severity: issue.severity, message: issue.message })),
    ...(run.plan?.narrativeGraph.warnings ?? []).map((warning) => ({ severity: "warning" as const, message: warning.message }))
  ];
  if (warnings.length === 0) return `<p class="script-manga-no-warnings">構造検証の警告はありません。</p>`;
  return `
    <ul class="script-manga-warnings">
      ${warnings.map((warning) => `
        <li class="is-${warning.severity}">
          <span>${warning.severity === "error" ? "ERROR" : "WARN"}</span>
          ${escapeHtml(warning.message)}
        </li>
      `).join("")}
    </ul>
  `;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** DB由来のunknown scoresを、boundedなVLM監査表示モデルへ変換する純関数。 */
export function scriptMangaVlmAuditFromScores(scores: unknown): ScriptMangaVlmAuditView | null {
  const scoreObject = jsonRecord(scores);
  const audit = jsonRecord(scoreObject?.vlmAudit);
  if (!audit || !["queued", "deferred", "completed", "unavailable"].includes(String(audit.state))) return null;
  const state = audit.state as ScriptMangaVlmAuditView["state"];
  const error = typeof audit.error === "string" && audit.error.trim() ? audit.error.trim().slice(0, 500) : null;
  if (state !== "completed") return { state, reports: [], error };

  const reports = Array.isArray(audit.reports) ? audit.reports.slice(0, 20).flatMap((rawReport) => {
    const report = jsonRecord(rawReport);
    if (
      !report ||
      typeof report.assetId !== "string" ||
      !report.assetId.trim() ||
      typeof report.score !== "number" ||
      !Number.isFinite(report.score) ||
      typeof report.passed !== "boolean"
    ) return [];
    const checks: Record<string, "pass" | "fail"> = {};
    for (const [name, result] of Object.entries(jsonRecord(report.checks) ?? {}).slice(0, 16)) {
      if ((result === "pass" || result === "fail") && name.trim()) checks[name.trim().slice(0, 80)] = result;
    }
    const violations = Array.isArray(report.violations)
      ? report.violations.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim().slice(0, 300)] : []).slice(0, 12)
      : [];
    return [{
      assetId: report.assetId.trim(),
      score: Math.min(1, Math.max(0, report.score)),
      passed: report.passed,
      checks,
      violations,
      model: typeof report.model === "string" ? report.model.trim().slice(0, 160) : ""
    }];
  }) : [];
  return { state, reports, error };
}

interface ScriptMangaExternalAuditReportView {
  assetId: string;
  passed: boolean;
  score: number | null;
  checks: Record<string, "pass" | "fail">;
  violations: string[];
  reviewer: string;
  model: string;
  notes: string;
  evaluatedAt: string;
}

/** DB由来のunknown scoresから、外部エージェント監査の表示に必要な項目だけを取り出す。 */
export function scriptMangaExternalAuditFromScores(scores: unknown): ScriptMangaExternalAuditReportView[] {
  const scoreObject = jsonRecord(scores);
  const audit = jsonRecord(scoreObject?.externalAudit);
  if (!audit || audit.state !== "completed" || !Array.isArray(audit.reports)) return [];
  return audit.reports.slice(0, 20).flatMap((rawReport) => {
    const report = jsonRecord(rawReport);
    if (!report || typeof report.assetId !== "string" || !report.assetId.trim() || typeof report.passed !== "boolean") {
      return [];
    }
    const checks: Record<string, "pass" | "fail"> = {};
    for (const [name, result] of Object.entries(jsonRecord(report.checks) ?? {}).slice(0, 16)) {
      if ((result === "pass" || result === "fail") && name.trim()) checks[name.trim().slice(0, 80)] = result;
    }
    const violations = Array.isArray(report.violations)
      ? report.violations.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim().slice(0, 300)] : []).slice(0, 32)
      : [];
    const score = typeof report.score === "number" && Number.isFinite(report.score)
      ? Math.min(1, Math.max(0, report.score))
      : null;
    return [{
      assetId: report.assetId.trim(),
      passed: report.passed,
      score,
      checks,
      violations,
      reviewer: typeof report.reviewer === "string" ? report.reviewer.trim().slice(0, 160) : "",
      model: typeof report.model === "string" ? report.model.trim().slice(0, 160) : "",
      notes: typeof report.notes === "string" ? report.notes.trim().slice(0, 2_000) : "",
      evaluatedAt: typeof report.evaluatedAt === "string" ? report.evaluatedAt.trim().slice(0, 80) : ""
    }];
  });
}

function renderVlmServiceStatus(status: VlmAuditServiceStatus | null, auditMode: ScriptMangaAuditMode): string {
  if (auditMode === "manual") {
    return `<span class="script-manga-vlm-service is-manual">内蔵VLM OFF · 外部/手動レビュー</span>`;
  }
  if (!status) {
    return `<span class="script-manga-vlm-service is-loading">VLM確認中</span>`;
  }
  const model = typeof status.model === "string" ? status.model.trim().slice(0, 160) : "";
  const error = typeof status.error === "string" ? status.error.trim().slice(0, 300) : "";
  if (status.state === "ready") {
    return `<span class="script-manga-vlm-service is-ready"${model ? ` title="${escapeAttr(model)}"` : ""}>VLM ready${model ? ` · ${escapeHtml(model)}` : ""}</span>`;
  }
  if (status.state === "model-not-loaded") {
    return `<span class="script-manga-vlm-service is-on-demand"${model ? ` title="${escapeAttr(model)}"` : ""}>VLM on-demand${model ? ` · ${escapeHtml(model)}` : ""}</span>`;
  }
  if (status.state === "unconfigured") {
    const detail = error || model;
    return `<span class="script-manga-vlm-service is-unconfigured"${detail ? ` title="${escapeAttr(detail)}"` : ""}>VLM未設定</span>`;
  }
  const detail = error || model;
  return `<span class="script-manga-vlm-service is-unreachable"${detail ? ` title="${escapeAttr(detail)}"` : ""}>VLM unreachable</span>`;
}

function renderCandidateVlmAudit(task: ScriptMangaTaskView, assetId: string, auditMode: ScriptMangaAuditMode): string {
  if (auditMode === "manual") {
    const report = scriptMangaExternalAuditFromScores(task.scores).find((item) => item.assetId === assetId);
    if (!report) {
      return `<div class="script-manga-vlm-result is-manual"><strong>外部エージェント / 人間レビュー</strong><span>監査結果は未登録</span></div>`;
    }
    const checkEntries = Object.entries(report.checks);
    const scoreLabel = report.score === null ? "" : ` ${Math.round(report.score * 100)}%`;
    const attribution = [report.reviewer, report.model].filter(Boolean).join(" · ");
    return `
      <div class="script-manga-vlm-result ${report.passed ? "is-pass" : "is-fail"}">
        <div class="script-manga-vlm-score">
          <strong>外部監査${scoreLabel}</strong>
          <span>${report.passed ? "PASS" : "FAIL"}</span>
        </div>
        ${checkEntries.length > 0 ? `
          <div class="script-manga-vlm-checks">
            ${checkEntries.map(([name, result]) => `<span class="is-${result}">${escapeHtml(name)}: ${result.toUpperCase()}</span>`).join("")}
          </div>
        ` : ""}
        ${report.violations.length > 0
          ? `<ul class="script-manga-vlm-violations">${report.violations.map((violation) => `<li>${escapeHtml(violation)}</li>`).join("")}</ul>`
          : `<p class="script-manga-vlm-clean">${report.passed ? "違反なし" : "違反詳細は未登録"}</p>`}
        ${report.notes ? `<p class="script-manga-vlm-clean">${escapeHtml(report.notes)}</p>` : ""}
        ${attribution ? `<span class="script-manga-vlm-model" title="${escapeAttr(attribution)}">${escapeHtml(attribution)}</span>` : ""}
      </div>
    `;
  }
  const audit = scriptMangaVlmAuditFromScores(task.scores);
  if (!audit) {
    return `<div class="script-manga-vlm-result is-pending"><strong>VLM結果待ち</strong><span>runを更新してください</span></div>`;
  }
  if (audit.state === "queued") {
    return `<div class="script-manga-vlm-result is-pending"><strong>VLM監査待ち</strong><span>VRAM入替キュー</span></div>`;
  }
  if (audit.state === "deferred") {
    return `
      <div class="script-manga-vlm-result is-pending">
        <strong>VLM監査を保留中</strong>
        <span>${escapeHtml(audit.error ?? "VRAM入替または他panelの完了待ち")}</span>
      </div>
    `;
  }
  if (audit.state === "unavailable") {
    return `
      <div class="script-manga-vlm-result is-unavailable">
        <strong>VLM利用不可</strong>
        <span>${escapeHtml(audit.error ?? "監査結果を取得できませんでした")}</span>
      </div>
    `;
  }
  const report = audit.reports.find((item) => item.assetId === assetId);
  if (!report) {
    return `<div class="script-manga-vlm-result is-unavailable"><strong>VLM結果なし</strong><span>この候補のreportがありません</span></div>`;
  }
  const checkEntries = Object.entries(report.checks);
  return `
    <div class="script-manga-vlm-result ${report.passed ? "is-pass" : "is-fail"}">
      <div class="script-manga-vlm-score">
        <strong>VLM ${Math.round(report.score * 100)}%</strong>
        <span>${report.passed ? "PASS" : "FAIL"}</span>
      </div>
      ${checkEntries.length > 0 ? `
        <div class="script-manga-vlm-checks">
          ${checkEntries.map(([name, result]) => `<span class="is-${result}">${escapeHtml(name)}: ${result.toUpperCase()}</span>`).join("")}
        </div>
      ` : ""}
      ${report.violations.length > 0
        ? `<ul class="script-manga-vlm-violations">${report.violations.map((violation) => `<li>${escapeHtml(violation)}</li>`).join("")}</ul>`
        : `<p class="script-manga-vlm-clean">違反なし</p>`}
      ${report.model ? `<span class="script-manga-vlm-model" title="${escapeAttr(report.model)}">${escapeHtml(report.model)}</span>` : ""}
    </div>
  `;
}

function renderCandidateTask(task: ScriptMangaTaskView, busy: boolean, auditMode: ScriptMangaAuditMode): string {
  return `
    <article class="script-manga-review-task">
      <div class="script-manga-review-heading">
        <div>
          <strong>panel ${escapeHtml(task.panelId)}</strong>
          <span>attempt ${task.attemptCount}</span>
        </div>
        <button class="button-secondary compact" type="button" data-action="retry-script-manga-task"
          data-id="${escapeAttr(task.id)}" ${busy ? "disabled" : ""}>このコマを再生成</button>
      </div>
      <div class="script-manga-candidate-grid">
        ${task.candidateAssetIds.length > 0
          ? task.candidateAssetIds.map((assetId) => {
              const encodedAssetId = encodeURIComponent(assetId);
              return `
                <div class="script-manga-candidate">
                  <a href="/api/assets/${encodedAssetId}/image" target="_blank" rel="noopener" title="原寸画像を開く">
                    <img src="/api/assets/${encodedAssetId}/thumbnail?size=medium" alt="候補 ${escapeAttr(assetId)}" loading="lazy" />
                  </a>
                  <code title="${escapeAttr(assetId)}">${escapeHtml(assetId)}</code>
                  ${renderCandidateVlmAudit(task, assetId, auditMode)}
                  <div class="script-manga-candidate-actions">
                    <a href="/api/assets/${encodedAssetId}/image" target="_blank" rel="noopener">原寸</a>
                    <button class="button-secondary compact" type="button" data-action="edit-script-manga-candidate-mask"
                      data-id="${escapeAttr(task.id)}" data-asset-id="${escapeAttr(assetId)}" ${busy ? "disabled" : ""}>マスク編集</button>
                    <button class="button-primary compact" type="button" data-action="select-script-manga-candidate"
                      data-id="${escapeAttr(task.id)}" data-asset-id="${escapeAttr(assetId)}" ${busy ? "disabled" : ""}>採用</button>
                  </div>
                </div>
              `;
            }).join("")
          : `<p class="script-empty-hint">候補assetを取得中です。更新してください。</p>`}
      </div>
    </article>
  `;
}

function renderVlmAuditProgress(run: ScriptMangaRunView, auditingTasks: ScriptMangaTaskView[]): string {
  if (run.auditMode !== "vlm" || auditingTasks.length === 0) return "";
  const deferred = auditingTasks.filter((task) => scriptMangaVlmAuditFromScores(task.scores)?.state === "deferred").length;
  return `
    <div class="script-manga-audit-progress" role="status" aria-live="polite">
      <span class="script-manga-audit-pulse" aria-hidden="true"></span>
      <div>
        <strong>VLM監査中 — ${auditingTasks.length} panel</strong>
        <span>${deferred > 0
          ? `${deferred} panelは監査再開待ち（VRAM入替待機中）`
          : "VRAM入替中（ComfyUIモデル解放 → VLM読込・監査）"}</span>
      </div>
    </div>
  `;
}

function renderRunSummary(run: ScriptMangaRunView, busy: boolean): string {
  const terminal = ["completed", "completed_with_errors", "canceled"].includes(run.status);
  const canApprove = run.validation?.ok === true && run.approvalStatus !== "approved" && run.status !== "canceled";
  const canStart = run.approvalStatus === "approved" && run.status === "approved";
  const canResume = run.approvalStatus === "approved" && !terminal && run.status !== "approved";
  const reviewTasks = run.tasks.filter((task) => task.status === "awaiting_review");
  const auditingTasks = run.tasks.filter((task) => task.status === "auditing");
  return `
    <div class="script-manga-run" data-run-id="${escapeAttr(run.id)}">
      <div class="script-manga-run-meta">
        <div><span>status</span><strong>${escapeHtml(run.status)}</strong></div>
        <div><span>phase</span><strong>${escapeHtml(run.phase)}</strong></div>
        <div><span>approval</span><strong>${escapeHtml(run.approvalStatus)}</strong></div>
        <div><span>pages / panels</span><strong>${run.pageCount} / ${run.panelCount}</strong></div>
        <div><span>completed / failed</span><strong>${run.completedCount} / ${run.failedCount}</strong></div>
        <div><span>audit</span><strong>${run.auditMode === "vlm" ? "embedded VLM + review" : "external / manual review"}</strong></div>
        <div><span>revision</span><strong title="${escapeAttr(run.scriptRevisionId ?? "")}">${escapeHtml(run.scriptRevisionId ?? "未固定")}</strong></div>
      </div>
      <div class="script-manga-run-actions">
        <button class="button-primary compact" type="button" data-action="approve-script-manga-run" ${busy || !canApprove ? "disabled" : ""}>承認</button>
        <button class="button-primary compact" type="button" data-action="start-script-manga-run" ${busy || !canStart ? "disabled" : ""}>生成開始</button>
        <button class="button-secondary compact" type="button" data-action="resume-script-manga-run" ${busy || !canResume ? "disabled" : ""}>再開</button>
        <button class="button-secondary compact" type="button" data-action="refresh-script-manga-run" ${busy ? "disabled" : ""}>更新</button>
        <button class="button-danger compact" type="button" data-action="cancel-script-manga-run" ${busy || terminal ? "disabled" : ""}>キャンセル</button>
      </div>
      ${run.status === "completed" ? `
        <div class="script-manga-export-actions" aria-label="完成ページを書き出す">
          <span>完成ページ</span>
          <button class="button-secondary compact" type="button" data-action="export-script-manga-run" data-format="png" ${busy ? "disabled" : ""}>PNG</button>
          <button class="button-secondary compact" type="button" data-action="export-script-manga-run" data-format="jpeg" ${busy ? "disabled" : ""}>JPEG</button>
          <button class="button-secondary compact" type="button" data-action="export-script-manga-run" data-format="pptx" ${busy ? "disabled" : ""}>PPTX</button>
          <button class="button-secondary compact" type="button" data-action="export-script-manga-run" data-format="ora" ${busy ? "disabled" : ""}>ORA</button>
        </div>
      ` : ""}
      ${renderVlmAuditProgress(run, auditingTasks)}
      ${renderRunWarnings(run)}
      ${run.lastError ? `<p class="script-manga-run-error">${escapeHtml(unknownSummary(run.lastError))}</p>` : ""}
      ${reviewTasks.length > 0 ? `
        <div class="script-manga-review-list">
          <h3>候補レビュー <span>${reviewTasks.length} panel</span></h3>
          ${reviewTasks.map((task) => renderCandidateTask(task, busy, run.auditMode)).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

// --- プラン候補比較(ネームv4 D3) ---

export type PlanCandidatesViewProps = Pick<
  ScriptViewProps,
  | "activeScriptId"
  | "activeScriptRevision"
  | "scriptMangaSettings"
  | "scriptMangaBusy"
  | "scriptMangaCandidates"
  | "scriptMangaCandidateBeatKinds"
  | "scriptMangaCandidateDialogueChars"
  | "scriptMangaCandidatesBusy"
  | "scriptMangaCandidateCount"
>;

/**
 * ページの構造署名(候補間diffの対応付け)。ページ位置・コマ境界・スケール・レイアウトを
 * 保つため、同じbeat列でもsplit/mergeや別ページへの移動を同一扱いしない。
 * optional sourceBeatIds は注釈器の有無で変わるため使わず、source/dialogue割当を正とする。
 */
export function candidatePageSignature(page: ScriptMangaPagePlan): string {
  return JSON.stringify([
    page.index,
    page.layoutTemplateId,
    page.turnHook ?? "",
    page.pageIntent?.trim() ?? "",
    page.panels.map((panel) => [
      panel.sceneIndex,
      panel.sourceElementIds,
      panel.dialogueOrderIndexes,
      panel.visualScale ?? ""
    ])
  ]);
}

/**
 * 候補全体の物語構造signature。pageIntentの言い換えや既定layoutは比較案を増やさず、
 * ページ/コマ境界・source/dialogue割当・スケール・めくり、または人間のlayout overrideが
 * 違う時だけ別案とする。
 */
export function candidatePlanStructureSignature(candidate: ScriptMangaPlanCandidateView): string {
  return sharedPlanStructureSignature(candidate.plan, candidate.layoutOverrides);
}

/** 候補間で「全候補に存在するページ署名」を除いた差分ページ署名集合を返す。候補1件なら空。 */
export function candidateDiffSignatures(candidates: readonly ScriptMangaPlanCandidateView[]): Set<string> {
  if (candidates.length < 2) return new Set();
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const unique = new Set(candidate.plan.pages.map(candidatePageSignature));
    for (const signature of unique) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const diff = new Set<string>();
  for (const [signature, count] of counts) {
    if (count < candidates.length) diff.add(signature);
  }
  return diff;
}

/** MangaPlanV2準備・run状態遷移・候補レビューを描画する純関数。 */
export function renderScriptMangaControlCard(props: ScriptMangaControlViewProps): string {
  const settings = props.scriptMangaSettings;
  const hasActiveRun = Boolean(props.scriptMangaRun && !["canceled", "failed", "completed"].includes(props.scriptMangaRun.status));
  const prepareDisabled = props.scriptMangaBusy || hasActiveRun || !props.activeScriptId || !props.activeScriptRevision || !settings.templateId;
  return `
    <section class="script-manga-card" aria-labelledby="script-manga-heading">
      <div class="script-manga-card-heading">
        <div>
          <h2 id="script-manga-heading">MangaPlan V2 / 一括生成</h2>
          <p>編集可能な計画を準備し、警告を確認してから画像生成を開始します。VLM監査を使っても候補の最終採用は人が行います。</p>
        </div>
        <button class="button-primary compact" type="button" data-action="prepare-script-manga-run" ${prepareDisabled ? "disabled" : ""}>
          ${props.scriptMangaBusy ? "処理中…" : "プラン準備"}
        </button>
      </div>
      <div class="script-manga-controls">
        <label class="script-field">
          <span>workflow template</span>
          <select data-script-manga-setting="templateId" ${props.scriptMangaBusy ? "disabled" : ""}>
            <option value="">選択してください</option>
            ${props.scriptMangaTemplates.map((template) => `
              <option value="${escapeAttr(template.id)}" ${template.id === settings.templateId ? "selected" : ""}>
                ${escapeHtml(template.name)} (${escapeHtml(template.type)})
              </option>
            `).join("")}
          </select>
        </label>
        <label class="script-field">
          <span title="target pages指定時は1ページあたりの上限。未指定時は最終ページを除く既定密度です。">panels / page (max)</span>
          <select data-script-manga-setting="panelsPerPage" ${props.scriptMangaBusy ? "disabled" : ""}>
            ${Array.from({ length: 6 }, (_, index) => index + 1).map((count) => `
              <option value="${count}" ${count === settings.panelsPerPage ? "selected" : ""}>${count}</option>
            `).join("")}
          </select>
        </label>
        <label class="script-field">
          <span title="吹き出し数ではなくFountainの台詞要素数。既定3、最終可否は文字preflightで判定します。">dialogues / panel (max)</span>
          <select data-script-manga-setting="maxDialoguesPerPanel" ${props.scriptMangaBusy ? "disabled" : ""}>
            ${Array.from({ length: 8 }, (_, index) => index + 1).map((count) => `
              <option value="${count}" ${count === settings.maxDialoguesPerPanel ? "selected" : ""}>${count}</option>
            `).join("")}
          </select>
        </label>
        <label class="script-field">
          <span>target pages</span>
          <select data-script-manga-setting="targetPageCount" ${props.scriptMangaBusy ? "disabled" : ""}>
            ${[0, 8, 12, 16, 24, 32, 48, 64, 96, 128].map((count) => `
              <option value="${count}" ${count === settings.targetPageCount ? "selected" : ""}>${count === 0 ? "auto" : `${count} pages`}</option>
            `).join("")}
          </select>
        </label>
        <label class="script-field">
          <span>max panels</span>
          <select data-script-manga-setting="maxPanelCount" ${props.scriptMangaBusy ? "disabled" : ""}>
            ${[0, 40, 80, 120, 160, 240, 320, 480, 800].map((count) => `
              <option value="${count}" ${count === settings.maxPanelCount ? "selected" : ""}>${count === 0 ? "no hard ceiling" : `${count} panels`}</option>
            `).join("")}
          </select>
        </label>
        <label class="script-field">
          <span>dialogue policy</span>
          <select data-script-manga-setting="dialoguePolicy" ${props.scriptMangaBusy ? "disabled" : ""}>
            <option value="preserve" ${settings.dialoguePolicy === "preserve" ? "selected" : ""}>preserve（原文維持）</option>
            <option value="adapt" ${settings.dialoguePolicy === "adapt" ? "selected" : ""}>adapt（原文一致の呼吸分割）</option>
            <option value="fill" ${settings.dialoguePolicy === "fill" ? "selected" : ""}>fill（分割＋caption/monitor/SFX）</option>
            <option value="generate" disabled>generate（今後対応）</option>
          </select>
        </label>
        <label class="script-field">
          <span>画像候補の監査</span>
          <select data-script-manga-setting="auditMode" ${props.scriptMangaBusy ? "disabled" : ""}>
            <option value="vlm" ${settings.auditMode === "vlm" ? "selected" : ""}>内蔵VLM自動監査 → 明示レビュー</option>
            <option value="manual" ${settings.auditMode === "manual" ? "selected" : ""}>外部エージェント / 人間レビュー（内蔵VLMなし）</option>
          </select>
        </label>
        <label class="script-field">
          <span>ポーズ骨格CN（実験的）</span>
          <select data-script-manga-setting="poseControl" ${props.scriptMangaBusy ? "disabled" : ""}>
            <option value="off" ${settings.poseControl === "off" ? "selected" : ""}>OFF（既定）</option>
            <option value="full" ${settings.poseControl === "full" ? "selected" : ""}>全身</option>
            <option value="upper" ${settings.poseControl === "upper" ? "selected" : ""}>腰から上</option>
            <option value="face" ${settings.poseControl === "face" ? "selected" : ""}>顔のみ</option>
          </select>
        </label>
      </div>
      <div class="script-manga-audit-setting-detail">
        <p class="script-manga-audit-note">
          ${settings.auditMode === "vlm"
            ? "生成完了後にComfyUIモデルを解放してVLMへVRAMを入れ替え、各候補を採点します。監査中は画像生成を待機します。"
            : "内蔵VLMを起動せず、生成された候補を外部の視覚対応エージェントまたは人が明示的に確認します。"}
        </p>
        ${renderVlmServiceStatus(props.scriptMangaVlmStatus, settings.auditMode)}
      </div>
      ${props.scriptMangaTemplates.length === 0
        ? `<p class="script-manga-run-error">利用できるworkflow templateがありません。ホームでtemplateを取り込んでください。</p>`
        : ""}
      ${props.scriptMangaRun
        ? renderRunSummary(props.scriptMangaRun, props.scriptMangaBusy)
        : `<p class="script-empty-hint">プラン準備後にpage/panel数、固定revision、検証警告、run phaseを確認できます。</p>`}
    </section>
  `;
}

function renderScriptTabs(scripts: MangaScript[], activeScriptId: string | null): string {
  if (scripts.length <= 1) {
    return "";
  }
  return `
    <div class="script-tabs">
      ${scripts
        .map(
          (script) => `
            <button class="button-secondary compact script-tab ${script.id === activeScriptId ? "is-active" : ""}"
              type="button" data-action="select-script" data-id="${escapeAttr(script.id)}">
              ${escapeHtml(script.title || "(無題)")}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderImportCard(props: ScriptViewProps): string {
  const warnings = props.activeScriptRevision?.warnings ?? [];
  return `
    <div class="script-import-card">
      <textarea class="script-fountain-textarea" rows="10" placeholder="Fountain 脚本を貼り付けてください。日本語話者は @キャラ名 で行頭を強制してください。"
        data-script-fountain="1">${escapeHtml(props.fountainDraft)}</textarea>
      <div class="script-import-actions">
        <button class="button-primary compact" type="button" data-action="import-script" ${props.importBusy ? "disabled" : ""}>
          ${props.importBusy ? "取り込み中…" : props.activeScriptId ? "再取り込み" : "取り込む"}
        </button>
        ${props.activeScriptRevision ? `<span class="script-revision-badge">revision ${props.activeScriptRevision.revision}</span>` : ""}
      </div>
      ${
        warnings.length > 0
          ? `<ul class="script-warnings">${warnings.map((warning) => `<li>⚠ ${escapeHtml(warning)}</li>`).join("")}</ul>`
          : ""
      }
    </div>
  `;
}

function renderDialogueLinesPanel(props: ScriptViewProps): string {
  const charactersById = new Map(props.characters.map((character) => [character.id, character]));
  const bySceneIndex = new Map<number, DialogueLine[]>();
  for (const line of props.dialogueLines) {
    const sceneIndex = line.sceneIndex ?? -1;
    const bucket = bySceneIndex.get(sceneIndex) ?? [];
    bucket.push(line);
    bySceneIndex.set(sceneIndex, bucket);
  }
  const scenes = props.activeScriptRevision?.parsed.scenes ?? [];
  const sceneIndices = [...bySceneIndex.keys()].sort((a, b) => a - b);

  return `
    <div class="script-panel script-lines-panel">
      <h2>シーン/セリフ</h2>
      ${
        props.dialogueLines.length === 0
          ? `<p class="script-empty-hint">脚本を取り込むとセリフ一覧が表示されます。</p>`
          : sceneIndices
              .map((sceneIndex) => {
                const heading = scenes[sceneIndex]?.heading || (sceneIndex < 0 ? "(見出し無し)" : `シーン ${sceneIndex + 1}`);
                const lines = bySceneIndex.get(sceneIndex) ?? [];
                return `
                  <div class="script-scene-group">
                    <h3 class="script-scene-heading">${escapeHtml(heading)}</h3>
                    ${lines.map((line) => renderDialogueLineRow(line, charactersById.get(line.characterId ?? ""), props.book)).join("")}
                  </div>
                `;
              })
              .join("")
      }
    </div>
  `;
}

function renderDialogueLineRow(line: DialogueLine, character: Character | undefined, book: BookPages): string {
  const color = character?.color ?? "#888888";
  const orphaned = line.status === "orphaned";
  return `
    <div class="script-line-row ${orphaned ? "is-orphaned" : ""}">
      <span class="script-line-speaker-dot" style="background:${escapeAttr(color)}"></span>
      <div class="script-line-body">
        <div class="script-line-meta">
          <span class="script-line-speaker">${escapeHtml(line.speakerLabel || character?.name || "(話者不明)")}</span>
          <span class="script-line-kind">${SEMANTIC_KIND_LABEL[line.semanticKind]}</span>
          ${orphaned ? `<span class="script-line-orphan-badge" title="最新の脚本に対応する行がありません">⚠ orphaned</span>` : ""}
        </div>
        <p class="script-line-text">${escapeHtml(line.text)}</p>
      </div>
      <select class="script-line-page-assign" data-dialogue-line-id="${escapeAttr(line.id)}" ${orphaned ? "disabled" : ""}>
        <option value="">ページへ割当…</option>
        ${book.pages
          .map(
            (page, index) =>
              `<option value="${escapeAttr(page.id)}">${escapeHtml(page.title || `ページ ${index + 1}`)}</option>`
          )
          .join("")}
      </select>
    </div>
  `;
}

function renderCharactersPanel(props: ScriptViewProps): string {
  return `
    <div class="script-panel script-characters-panel">
      <div class="script-panel-heading">
        <h2>キャラクター</h2>
        <button class="button-secondary compact" type="button" data-action="add-character">${iconPlus()}追加</button>
      </div>
      <div class="script-character-list">
        ${props.characters
          .map(
            (character) => `
              <button class="script-character-chip ${character.id === props.selectedCharacterId ? "is-active" : ""}"
                type="button" data-action="select-character" data-id="${escapeAttr(character.id)}">
                <span class="script-character-dot" style="background:${escapeAttr(character.color ?? "#888888")}"></span>
                ${escapeHtml(character.name)}
              </button>
            `
          )
          .join("")}
      </div>
      ${props.selectedCharacterId ? renderCharacterEditor(props) : ""}
    </div>
  `;
}

function renderCharacterEditor(props: ScriptViewProps): string {
  const character = props.characters.find((item) => item.id === props.selectedCharacterId);
  if (!character) {
    return "";
  }
  const binding = props.selectedCharacterBinding;
  return `
    <div class="script-character-editor">
      <label class="script-field">
        <span>名前</span>
        <input type="text" data-character-field="name" value="${escapeAttr(character.name)}" />
      </label>
      <label class="script-field">
        <span>色</span>
        <input type="color" data-character-field="color" value="${escapeAttr(character.color ?? "#888888")}" />
      </label>
      <label class="script-field">
        <span>口調・関係性メモ</span>
        <textarea rows="3" data-character-field="notes">${escapeHtml(character.notes)}</textarea>
      </label>
      <div class="script-character-binding">
        <h3>顔参照(comfy)</h3>
        ${
          binding?.hasFaceImage
            ? `
              <div class="script-face-preview">
                <img src="${escapeAttr(binding.faceImageUrl ?? "")}" alt="${escapeAttr(character.name)}の顔参照" />
                <button class="button-secondary compact" type="button" data-action="clear-character-face-image">${iconTrash()}クリア</button>
              </div>
            `
            : `<p class="script-empty-hint">顔参照画像は未設定です。</p>`
        }
        <label class="button-secondary compact source-upload-button">
          画像をアップロード
          <input type="file" accept="image/png,image/jpeg,image/webp" data-character-face-upload="1" />
        </label>
        <button class="button-secondary compact" type="button" data-action="toggle-character-face-picker">最近使った画像から選ぶ</button>
        ${props.characterFacePickerOpen ? renderFacePicker(props.recentImages) : ""}
      </div>
      <div class="script-character-lora">
        <h3>スタイル LoRA(comfy)</h3>
        <label class="script-field">
          <span>LoRA</span>
          <select data-character-lora-field="name">
            <option value="">(なし)</option>
            ${props.loraChoices
              .map(
                (name) =>
                  `<option value="${escapeAttr(name)}" ${name === props.characterLoraNameDraft ? "selected" : ""}>${escapeHtml(name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="script-field">
          <span>強度</span>
          <input type="number" min="0" max="2" step="0.05" data-character-lora-field="strength" value="${props.characterLoraStrengthDraft}" />
        </label>
        <button class="button-primary compact" type="button" data-action="save-character-lora">保存</button>
      </div>
      <button class="button-danger compact" type="button" data-action="delete-character">${iconTrash()}このキャラクターを削除</button>
    </div>
  `;
}

function renderFacePicker(recentImages: RecentReferenceImage[]): string {
  if (recentImages.length === 0) {
    return `<p class="script-empty-hint">最近使った画像がありません。</p>`;
  }
  return `
    <div class="script-face-picker-grid">
      ${recentImages
        .map(
          (image) => `
            <button class="script-face-picker-item" type="button" data-action="use-character-face-recent" data-url="${escapeAttr(image.url)}">
              <img src="${escapeAttr(image.thumbnailUrl)}" alt="" loading="lazy" />
            </button>
          `
        )
        .join("")}
    </div>
  `;
}
