/**
 * manga_scripts / script_revisions の共通ルックアップ。scriptManga.ts・
 * scriptMangaPlanCandidates.ts・scriptMangaCandidatePreflight.ts に三重実装されていた
 * requireScript / latestRevision をここへ集約する。
 */
import type { FountainDoc } from "../shared/fountain";
import { getRow } from "./db";
import { HttpError } from "./http";

export function requireScript(projectId: string, scriptId: string): void {
  if (!getRow("SELECT id FROM manga_scripts WHERE id = ? AND project_id = ?", [scriptId, projectId])) {
    throw new HttpError(404, "Script was not found in this project");
  }
}

/**
 * 最新 revision の生行(parsed_json 未パース)。パース失敗の扱いを呼び出し側が握りたい場合
 * (preflight のように fixed direction 時は一切パースしない経路)にはこちらを使う。
 */
export function latestRevisionRow(scriptId: string): { id: string; parsed_json: string } {
  const row = getRow<{ id: string; parsed_json: string }>(
    "SELECT id, parsed_json FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [scriptId]
  );
  if (!row) throw new HttpError(400, "Script has no Fountain revision");
  return row;
}

export function latestRevision(scriptId: string): { id: string; doc: FountainDoc } {
  const row = latestRevisionRow(scriptId);
  try {
    return { id: row.id, doc: JSON.parse(row.parsed_json) as FountainDoc };
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}
