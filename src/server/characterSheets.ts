import { readFile, realpath } from "node:fs/promises";
import sharp from "sharp";
import type { GenerationRequest } from "../shared/types";
import { dataRoot, getRow } from "./db";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { createGenerationRound } from "./rounds";
import { putCharacterBinding } from "./characters";
import { objectBody, requiredString, stringOr } from "./validate";

interface CharacterRow { id: string; project_id: string; name: string; notes: string }

/** 3角度×3表情のキャラシート候補を通常Roundの人間review経路へ投入する専用run。 */
export async function createCharacterSheetRun(characterId: string, body: unknown) {
  const character = getRow<CharacterRow>("SELECT id, project_id, name, notes FROM characters WHERE id = ?", [characterId]);
  if (!character) throw new HttpError(404, "Character was not found");
  const input = objectBody(body);
  const templateId = requiredString(input.templateId, "templateId");
  const appearance = stringOr(input.appearanceTags, "") || character.notes;
  if (!appearance.trim()) throw new HttpError(400, "appearanceTags or character notes are required");
  const request: GenerationRequest & { providerId?: string } = {
    templateId,
    prompt: ["professional anime manga character turnaround sheet", "single consistent character", appearance,
      "clean 3 by 3 reference grid", "front view, three-quarter view, profile view",
      "neutral expression, smiling expression, angry expression", "same face, same hairstyle, same outfit in every cell", "plain light background", "no text"].join(", "),
    negativePrompt: "different characters, inconsistent face, inconsistent outfit, cropped head, text, letters, watermark, extra limbs, deformed",
    seed: null, seedMode: "random", batchSize: 2, steps: typeof input.steps === "number" ? input.steps : 28,
    cfg: typeof input.cfg === "number" ? input.cfg : 6, sampler: stringOr(input.sampler, "euler"),
    scheduler: stringOr(input.scheduler, "normal"), denoise: 1, width: 1024, height: 1024,
    generationMode: "txt2img", loras: [], reference: null, providerId: stringOr(input.providerId, "comfy")
  };
  const created = await createGenerationRound(character.project_id, request);
  return { ...created, characterId, kind: "character-sheet" as const };
}

/** 人間が採用したシートの左上(front/neutral)セルを顔参照へ自動登録する。 */
export async function adoptCharacterSheetAsset(characterId: string, assetId: string, providerId = "comfy") {
  const character = getRow<CharacterRow>("SELECT id, project_id, name, notes FROM characters WHERE id = ?", [characterId]);
  const asset = getRow<{ project_id: string; image_path: string }>("SELECT project_id, image_path FROM assets WHERE id = ?", [assetId]);
  if (!character || !asset || asset.project_id !== character.project_id) throw new HttpError(404, "Character sheet candidate was not found");
  const root = await realpath(dataRoot);
  const source = await realpath(asset.image_path);
  if (!isPathInside(source, root)) throw new HttpError(400, "Character sheet path is outside data root");
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0, height = metadata.height ?? 0;
  if (width < 3 || height < 3) throw new HttpError(422, "Character sheet image is too small");
  const cellWidth = Math.floor(width / 3), cellHeight = Math.floor(height / 3);
  const bytes = await sharp(await readFile(source)).extract({ left: 0, top: 0, width: cellWidth, height: cellHeight }).png().toBuffer();
  const binding = await putCharacterBinding(characterId, providerId, { faceImageDataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
  return { characterId, assetId, binding };
}
