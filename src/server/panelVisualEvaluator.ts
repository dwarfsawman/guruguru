import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { PanelSpec } from "../shared/mangaPlanV2";
import type { LlmSettings, VlmAuditSettings } from "../shared/types";
import { dataRoot, getRow } from "./db";
import { chatCompletion, type ChatMessage } from "./llm";
import { isPathInside } from "./paths";

export type PanelVisualCheckResult = "pass" | "fail";

export interface PanelVisualAuditChecks {
  visualIdentity: PanelVisualCheckResult;
  actionAlignment: PanelVisualCheckResult;
  fakeText: PanelVisualCheckResult;
  continuity: PanelVisualCheckResult;
}

export interface PanelVisualAuditResult {
  assetId: string;
  score: number;
  passed: boolean;
  checks: PanelVisualAuditChecks;
  violations: string[];
  model: string;
  evaluatedAt: string;
}

export interface EvaluatePanelCandidateInput {
  assetId: string;
  panel: PanelSpec;
  settings: VlmAuditSettings;
  signal?: AbortSignal;
}

interface AssetRow {
  id: string;
  project_id: string;
  thumbnail_medium_path: string;
}

interface CharacterBindingRow {
  binding_json: string;
}

interface CharacterReferenceImage {
  characterId: string;
  providerId: string;
  dataUrl: string;
}

interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

interface TextContentPart {
  type: "text";
  text: string;
}

interface MultimodalChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<ImageContentPart | TextContentPart>;
}

const CHECK_NAMES = ["visualIdentity", "actionAlignment", "fakeText", "continuity"] as const;
const RESPONSE_KEYS = ["checks", "score", "violations"] as const;
const MAX_VIOLATIONS = 32;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "checks", "violations"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    checks: {
      type: "object",
      additionalProperties: false,
      required: [...CHECK_NAMES],
      properties: Object.fromEntries(CHECK_NAMES.map((name) => [name, { type: "string", enum: ["pass", "fail"] }]))
    },
    violations: {
      type: "array",
      maxItems: MAX_VIOLATIONS,
      items: { type: "string", minLength: 1, maxLength: 300 }
    }
  }
};

const SYSTEM_PROMPT = [
  "You are a strict manga panel visual auditor.",
  "Image 1 is the generated candidate panel. Later images, when present, are character identity references in the order described by the request.",
  "Compare only visible evidence with the supplied PanelSpec constraints. Do not reward image aesthetics when a required entity, action, prop, shot, or continuity state is wrong.",
  "For fakeText, pass means that no unintended readable text, pseudo-text, speech bubble, caption, watermark, logo, or signage is visible.",
  "Return exactly one JSON object matching the supplied schema, with no markdown or commentary. Use short stable violation strings such as 'visual-identity: focal character does not match reference'."
].join("\n");

/**
 * Audits one persisted candidate asset against its PanelSpec. The candidate's medium thumbnail and
 * any character-binding face references are read only after lexical and real-path containment checks
 * against dataRoot. Image bytes and paths are intentionally absent from the returned result.
 *
 * Network, file, and validation failures are allowed to throw so the orchestration layer can apply
 * its fail-open/manual-review policy without accidentally treating an unavailable audit as a pass.
 */
export async function evaluatePanelCandidate(input: EvaluatePanelCandidateInput): Promise<PanelVisualAuditResult> {
  validateSettings(input.settings);
  const asset = getRow<AssetRow>(
    "SELECT id, project_id, thumbnail_medium_path FROM assets WHERE id = ?",
    [input.assetId]
  );
  if (!asset) throw new PanelVisualEvaluationError("Candidate asset was not found");

  const candidateDataUrl = await imageDataUrlInsideDataRoot(asset.thumbnail_medium_path, "Candidate medium thumbnail");
  const references = await loadCharacterReferences(
    asset.project_id,
    input.panel,
    Math.trunc(input.settings.maxReferenceImages)
  );
  const messages = buildMessages(candidateDataUrl, references, input.panel);
  const content = input.settings.transport === "lmstudio-native"
    ? await nativeLmStudioAudit(input.settings, candidateDataUrl, references, input.panel, input.signal)
    : (await chatCompletion(
        {
          baseUrl: input.settings.baseUrl,
          model: input.settings.model,
          systemPrompt: SYSTEM_PROMPT,
          temperature: input.settings.temperature
        } satisfies LlmSettings,
        {
          // chatCompletion serializes messages without inspecting their content. Keep the multimodal type
          // local until the shared text client grows a public content-parts contract.
          messages: messages as unknown as ChatMessage[],
          temperature: input.settings.temperature,
          responseFormat: {
            type: "json_schema",
            json_schema: {
              name: "panel_visual_audit",
              strict: true,
              schema: RESPONSE_SCHEMA
            }
          },
          timeoutMs: Math.round(input.settings.timeoutSeconds * 1000),
          signal: input.signal
        }
      )).content;
  const parsed = parseAuditResponse(content);
  const checksPassed = CHECK_NAMES.every((name) => parsed.checks[name] === "pass");
  return {
    assetId: asset.id,
    score: parsed.score,
    passed: parsed.score >= input.settings.passThreshold && checksPassed && parsed.violations.length === 0,
    checks: parsed.checks,
    violations: parsed.violations,
    model: input.settings.model,
    evaluatedAt: new Date().toISOString()
  };
}

async function nativeLmStudioAudit(
  settings: VlmAuditSettings,
  candidateDataUrl: string,
  references: CharacterReferenceImage[],
  panel: PanelSpec,
  externalSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.round(settings.timeoutSeconds * 1000));
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const constraintText = JSON.stringify({
    task: "Audit the first image against this PanelSpec. Later images are identity references only.",
    referenceImages: references.map((reference, index) => ({
      imageIndex: index + 2,
      characterId: reference.characterId,
      providerId: reference.providerId
    })),
    panel: panelAuditConstraints(panel),
    requiredJsonSchema: RESPONSE_SCHEMA
  });
  try {
    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        system_prompt: SYSTEM_PROMPT,
        input: [
          { type: "text", content: constraintText },
          { type: "image", data_url: candidateDataUrl },
          ...references.map((reference) => ({ type: "image", data_url: reference.dataUrl }))
        ],
        temperature: settings.temperature,
        reasoning: "off",
        context_length: settings.contextLength ?? 4096,
        max_output_tokens: 700,
        store: false
      })
    });
    const text = await response.text();
    if (!response.ok) throw new PanelVisualEvaluationError(`LM Studio VLM returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    let body: { output?: Array<{ type?: unknown; content?: unknown }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new PanelVisualEvaluationError("LM Studio VLM returned invalid JSON");
    }
    const content = body.output?.findLast((item) => item.type === "message" && typeof item.content === "string")?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new PanelVisualEvaluationError("LM Studio VLM response did not contain an audit message");
    }
    return content.trim();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PanelVisualEvaluationError(externalSignal?.aborted ? "VLM audit was canceled" : "VLM audit timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function validateSettings(settings: VlmAuditSettings): void {
  if (!settings.baseUrl.trim() || !settings.model.trim()) {
    throw new PanelVisualEvaluationError("VLM audit base URL and model are required");
  }
  if (!Number.isFinite(settings.temperature)) {
    throw new PanelVisualEvaluationError("VLM audit temperature must be finite");
  }
  if (!Number.isFinite(settings.timeoutSeconds) || settings.timeoutSeconds <= 0) {
    throw new PanelVisualEvaluationError("VLM audit timeoutSeconds must be positive");
  }
  if (!Number.isInteger(settings.maxReferenceImages) || settings.maxReferenceImages < 0) {
    throw new PanelVisualEvaluationError("VLM audit maxReferenceImages must be a non-negative integer");
  }
  if (!Number.isFinite(settings.passThreshold) || settings.passThreshold < 0 || settings.passThreshold > 1) {
    throw new PanelVisualEvaluationError("VLM audit passThreshold must be between 0 and 1");
  }
}

async function loadCharacterReferences(
  projectId: string,
  panel: PanelSpec,
  limit: number
): Promise<CharacterReferenceImage[]> {
  if (limit === 0) return [];
  const references: CharacterReferenceImage[] = [];
  const seenBindings = new Set<string>();
  for (const reference of panel.referenceManifest) {
    if (references.length >= limit) break;
    if (reference.artifact.kind !== "characterBinding") continue;
    const { characterId, providerId } = reference.artifact;
    const bindingKey = `${characterId}\u0000${providerId}`;
    if (seenBindings.has(bindingKey)) continue;
    seenBindings.add(bindingKey);
    const row = getRow<CharacterBindingRow>(
      `SELECT cb.binding_json
       FROM character_bindings cb
       JOIN characters c ON c.id = cb.character_id
       WHERE cb.character_id = ? AND cb.provider_id = ? AND c.project_id = ?`,
      [characterId, providerId, projectId]
    );
    const faceImagePath = bindingFaceImagePath(row?.binding_json);
    if (!faceImagePath) continue;
    references.push({
      characterId,
      providerId,
      dataUrl: await imageDataUrlInsideDataRoot(faceImagePath, "Character binding reference")
    });
  }
  return references;
}

function bindingFaceImagePath(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { faceImagePath?: unknown };
    return typeof value.faceImagePath === "string" && value.faceImagePath.trim() ? value.faceImagePath : null;
  } catch {
    return null;
  }
}

async function imageDataUrlInsideDataRoot(filePath: string, label: string): Promise<string> {
  const root = resolve(dataRoot);
  const candidate = resolve(filePath);
  if (!isPathInside(candidate, root)) {
    throw new PanelVisualEvaluationError(`${label} is outside the application data directory`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch {
    throw new PanelVisualEvaluationError(`${label} could not be resolved`);
  }
  if (!isPathInside(realCandidate, realRoot)) {
    throw new PanelVisualEvaluationError(`${label} resolves outside the application data directory`);
  }
  let bytes: Buffer;
  try {
    const info = await stat(realCandidate);
    if (!info.isFile()) throw new Error("not a file");
    bytes = await readFile(realCandidate);
  } catch {
    throw new PanelVisualEvaluationError(`${label} could not be read`);
  }
  return `data:${imageMimeType(realCandidate)};base64,${bytes.toString("base64")}`;
}

function imageMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      throw new PanelVisualEvaluationError("Audit image has an unsupported file extension");
  }
}

function buildMessages(
  candidateDataUrl: string,
  references: CharacterReferenceImage[],
  panel: PanelSpec
): MultimodalChatMessage[] {
  const content: Array<ImageContentPart | TextContentPart> = [
    { type: "image_url", image_url: { url: candidateDataUrl } },
    ...references.map((reference): ImageContentPart => ({ type: "image_url", image_url: { url: reference.dataUrl } })),
    {
      type: "text",
      text: JSON.stringify({
        task: "Audit image 1 against this PanelSpec. Images 2..N are identity references only.",
        referenceImages: references.map((reference, index) => ({
          imageIndex: index + 2,
          characterId: reference.characterId,
          providerId: reference.providerId
        })),
        panel: panelAuditConstraints(panel),
        checkDefinitions: {
          visualIdentity: "Expected cast is present and visually matches supplied identity references and variants.",
          actionAlignment: "Visible action, expression, pose, props, setting, shot and composition satisfy PanelSpec.",
          fakeText: "No unintended readable or pseudo text, bubbles, captions, watermarks, logos or signage are visible.",
          continuity: "Visible outfit, held props, setting and state do not contradict the supplied continuity constraints."
        }
      })
    }
  ];
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content }
  ];
}

function panelAuditConstraints(panel: PanelSpec): Record<string, unknown> {
  return {
    id: panel.id,
    sceneIndex: panel.sceneIndex,
    sceneHeading: panel.sceneHeading,
    settingId: panel.settingId,
    preStateId: panel.preStateId,
    postStateDelta: panel.postStateDelta,
    cast: panel.cast.map((member) => ({
      characterId: member.characterId,
      variantId: member.variantId,
      bbox: member.bbox,
      pose: member.pose,
      gazeTarget: member.gazeTarget,
      expression: member.expression,
      action: member.action,
      speaking: member.speakingLineIds.length > 0
    })),
    props: panel.props,
    shot: panel.shot,
    mustShow: panel.mustShow,
    mustNotShow: panel.mustNotShow,
    textSafeZones: panel.textSafeZones,
    continuityFromPanelIds: panel.continuityFromPanelIds,
    sourceText: panel.sourceText,
    compiledPrompt: panel.compiledPrompt
  };
}

function parseAuditResponse(content: string): { score: number; checks: PanelVisualAuditChecks; violations: string[] } {
  let value: unknown;
  try {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
    value = JSON.parse(fenced?.[1] ?? content);
  } catch {
    throw new PanelVisualEvaluationError("VLM audit response was not strict JSON");
  }
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    throw new PanelVisualEvaluationError("VLM audit response has an invalid top-level shape");
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) {
    throw new PanelVisualEvaluationError("VLM audit score must be between 0 and 1");
  }
  if (!isRecord(value.checks) || !hasExactKeys(value.checks, CHECK_NAMES)) {
    throw new PanelVisualEvaluationError("VLM audit checks have an invalid shape");
  }
  const checks = {} as PanelVisualAuditChecks;
  for (const name of CHECK_NAMES) {
    const result = value.checks[name];
    if (result !== "pass" && result !== "fail") {
      throw new PanelVisualEvaluationError(`VLM audit check ${name} must be pass or fail`);
    }
    checks[name] = result;
  }
  if (!Array.isArray(value.violations) || value.violations.length > MAX_VIOLATIONS) {
    throw new PanelVisualEvaluationError("VLM audit violations must be a bounded string array");
  }
  const violations: string[] = [];
  for (const violation of value.violations) {
    if (typeof violation !== "string" || !violation.trim() || violation.length > 300) {
      throw new PanelVisualEvaluationError("VLM audit violation entries must be short non-empty strings");
    }
    const normalized = violation.trim();
    if (!violations.includes(normalized)) violations.push(normalized);
  }
  return { score: value.score, checks, violations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export class PanelVisualEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelVisualEvaluationError";
  }
}
