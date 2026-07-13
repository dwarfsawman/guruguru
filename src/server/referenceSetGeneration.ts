import type { GenerationRequest } from "../shared/types";
import { detectWorkflowModelFamily } from "../shared/workflowModels";
import { getRow } from "./db";
import { HttpError } from "./http";
import { attachReferenceGenerationRound } from "./referenceSets";
import { createGenerationRound } from "./rounds";
import { objectBody, stringOr } from "./validate";

interface GenerationSetRow {
  id: string;
  character_id: string;
  project_id: string;
  character_name: string;
  model_family: "chroma" | "anima";
  version: number;
  status: string;
  appearance_prompt_en: string;
  must_not_change_json: string;
}

function deterministicSeed(characterId: string, version: number, role: string): number {
  let value = 2166136261;
  for (const char of `${characterId}:${version}:${role}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function mustNotChange(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

/** Starts review candidates only; generated images are never approved automatically. */
export async function generateReferenceSetCandidates(setId: string, body: unknown) {
  const set = getRow<GenerationSetRow>(
    `SELECT rs.id, rs.character_id, rs.model_family, rs.version, rs.status, rs.appearance_prompt_en, rs.must_not_change_json,
            c.project_id, c.name AS character_name
     FROM character_reference_sets rs JOIN characters c ON c.id = rs.character_id WHERE rs.id = ?`, [setId]
  );
  if (!set) throw new HttpError(404, "Reference Set was not found");
  if (!["draft", "review"].includes(set.status)) {
    throw new HttpError(409, "Approved or generating Reference Sets are immutable; create a new version first");
  }
  const input = objectBody(body);
  const requestedTemplateId = stringOr(input.templateId, "").trim();
  const template = requestedTemplateId
    ? getRow<{ id: string; workflow_json: string }>("SELECT id, workflow_json FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [requestedTemplateId])
    : getRow<{ id: string; workflow_json: string }>(
        `SELECT wt.id, wt.workflow_json FROM projects p JOIN workflow_templates wt ON wt.id = p.default_template_id
         WHERE p.id = ? AND wt.deleted_at IS NULL`, [set.project_id]
      );
  if (!template) throw new HttpError(400, "A default or explicit WorkflowTemplate is required for reference generation");
  const family = detectWorkflowModelFamily(JSON.parse(template.workflow_json));
  if (family !== set.model_family) throw new HttpError(400, `Workflow family ${family} does not match Reference Set family ${set.model_family}`);
  const invariant = mustNotChange(set.must_not_change_json).join(", ");
  const roles = set.model_family === "anima" ? (["face", "full_body"] as const) : (["face"] as const);
  const rounds: Array<{ role: "face" | "full_body"; roundId: string }> = [];
  for (const role of roles) {
    const isFace = role === "face";
    const prompt = [
      "professional anime manga character reference",
      "one character only",
      isFace ? "head and shoulders close-up, front three-quarter view" : "full body from head to toe, neutral standing pose",
      set.appearance_prompt_en,
      invariant ? `identity invariants: ${invariant}` : "",
      "plain neutral studio background, even lighting, no props, no text, no watermark"
    ].filter(Boolean).join(", ");
    const request: GenerationRequest & { providerId?: string } = {
      templateId: template.id,
      prompt,
      negativePrompt: "multiple people, cropped subject, inconsistent face, inconsistent hair, inconsistent outfit, busy background, props, text, watermark, deformed anatomy",
      seed: deterministicSeed(set.character_id, set.version, role),
      seedMode: "fixed",
      batchSize: 2,
      steps: typeof input.steps === "number" ? input.steps : 28,
      cfg: typeof input.cfg === "number" ? input.cfg : 5,
      sampler: stringOr(input.sampler, "euler"),
      scheduler: stringOr(input.scheduler, set.model_family === "anima" ? "simple" : "beta"),
      denoise: 1,
      width: isFace ? 768 : 512,
      height: 768,
      generationMode: "txt2img",
      loras: [],
      reference: null,
      providerId: "comfy"
    };
    const created = await createGenerationRound(set.project_id, request);
    if (!created.round) throw new Error("Reference candidate Round was not created");
    attachReferenceGenerationRound(set.id, role, created.round.id);
    rounds.push({ role, roundId: created.round.id });
  }
  return { referenceSetId: set.id, status: "generating" as const, rounds, requiresHumanApproval: true };
}
