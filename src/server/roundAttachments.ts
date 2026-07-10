import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { dataRoot, getRow } from "./db";
import { HttpError } from "./http";
import { streamFile } from "./files";
import { isPathInside } from "./paths";
import type { GenerationRequest } from "../shared/types";

/**
 * Round に添付されたファイル参照の種類。extracted from rounds.ts (Docs/Feature-ScriptToManga.md S1)
 * so that GenerationIntent の ArtifactRef 解決(providers/types.ts の resolveIntentArtifacts)が
 * rounds.ts を逆 import せずに済むようにする。"composite" は pasteComposite(貼り付け合成画像)用に
 * S1 で追加(既存の mask/pose/reference と同じ規約: request_json 内のパスを isPathInside ガード付きで解決)。
 */
export type RoundAttachmentKind = "mask" | "pose" | "reference" | "composite";

export function roundAttachmentPathFromRequest(request: GenerationRequest, kind: RoundAttachmentKind): string | null {
  const path =
    kind === "mask"
      ? request.inpaint?.maskPath
      : kind === "pose"
        ? request.controlnet?.poseImagePath
        : kind === "reference"
          ? request.reference?.imagePath
          : request.pasteComposite?.compositePath;
  return typeof path === "string" && path.trim() !== "" ? path : null;
}

export function resolveRoundAttachmentPath(roundId: string, kind: RoundAttachmentKind): string {
  const round = getRow<{ request_json: string }>("SELECT request_json FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }
  let request: GenerationRequest;
  try {
    request = JSON.parse(round.request_json) as GenerationRequest;
  } catch {
    throw new HttpError(404, "Round attachment was not found");
  }
  const path = roundAttachmentPathFromRequest(request, kind);
  const resolved = path ? resolve(path) : "";
  if (!resolved || !isPathInside(resolved, resolve(dataRoot))) {
    throw new HttpError(404, "Round attachment was not found");
  }
  return resolved;
}

export function serveRoundAttachment(res: ServerResponse, roundId: string, kind: RoundAttachmentKind) {
  streamFile(res, resolveRoundAttachmentPath(roundId, kind));
}
