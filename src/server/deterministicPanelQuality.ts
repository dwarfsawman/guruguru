import { realpath } from "node:fs/promises";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataRoot, getRow } from "./db";
import { isPathInside } from "./paths";

export interface DeterministicPanelQualityReport {
  assetId: string;
  passed: boolean;
  metrics: { luminanceStdDev: number; saturationMean: number; edgeDensity: number; pseudoTextRisk: number; ocrTokens: string[]; identitySimilarity: number | null };
  violations: string[];
}

/** モデル非依存の崩壊/偽文字候補ゲート。候補は捨てず、reroll判断用の証拠だけを返す。 */
async function imageEmbedding(path: string): Promise<number[]> {
  const bytes = await sharp(path).resize(32, 32, { fit: "cover" }).greyscale().raw().toBuffer();
  const mean = bytes.reduce((sum, value) => sum + value, 0) / Math.max(1, bytes.length);
  const vector = Array.from(bytes, (value) => (value - mean) / 255);
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export async function evaluateDeterministicPanelQuality(assetId: string, characterIds: string[] = []): Promise<DeterministicPanelQualityReport> {
  const row = getRow<{ thumbnail_medium_path: string }>("SELECT thumbnail_medium_path FROM assets WHERE id = ?", [assetId]);
  if (!row) throw new Error("Candidate asset was not found");
  const root = await realpath(dataRoot);
  const path = await realpath(row.thumbnail_medium_path);
  if (!isPathInside(path, root)) throw new Error("Candidate thumbnail is outside data root");
  const { data, info } = await sharp(path).resize({ width: 256, height: 256, fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const luminances: number[] = [];
  let saturationSum = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index]!, g = data[index + 1]!, b = data[index + 2]!;
    luminances.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    saturationSum += max === 0 ? 0 : (max - min) / max;
  }
  const mean = luminances.reduce((sum, value) => sum + value, 0) / Math.max(1, luminances.length);
  const std = Math.sqrt(luminances.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, luminances.length));
  let edges = 0;
  let highContrastHorizontal = 0;
  const width = info.width;
  for (let y = 1; y < info.height; y += 1) for (let x = 1; x < width; x += 1) {
    const index = y * width + x;
    const dx = Math.abs(luminances[index]! - luminances[index - 1]!);
    const dy = Math.abs(luminances[index]! - luminances[index - width]!);
    if (dx + dy > 55) edges += 1;
    if (dx > 80 && dy < 24) highContrastHorizontal += 1;
  }
  const sampleCount = Math.max(1, (info.width - 1) * (info.height - 1));
  const edgeDensity = edges / sampleCount;
  const pseudoTextRisk = highContrastHorizontal / sampleCount;
  let ocrTokens: string[] = [];
  try {
    const { stdout } = await promisify(execFile)("tesseract", [path, "stdout", "-l", "eng", "--psm", "11"], { timeout: 15000, windowsHide: true });
    ocrTokens = [...new Set(stdout.match(/[A-Za-z0-9][A-Za-z0-9_.-]{2,}/g) ?? [])].slice(0, 12);
  } catch {
    // OCRが利用できない環境は統計gateだけでfail-open。VLM/人間reviewは残る。
  }
  const saturationMean = saturationSum / Math.max(1, luminances.length);
  let identitySimilarity: number | null = null;
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => "?").join(",");
    const bindings = getRow<{ binding_json: string }>(
      `SELECT binding_json FROM character_bindings WHERE character_id IN (${placeholders}) AND provider_id = 'comfy' ORDER BY updated_at DESC LIMIT 1`,
      characterIds
    );
    if (bindings) {
      try {
        const parsed = JSON.parse(bindings.binding_json) as { faceImagePath?: string };
        if (parsed.faceImagePath) {
          const [candidateEmbedding, referenceEmbedding] = await Promise.all([imageEmbedding(path), imageEmbedding(parsed.faceImagePath)]);
          identitySimilarity = candidateEmbedding.reduce((sum, value, index) => sum + value * referenceEmbedding[index]!, 0);
        }
      } catch { identitySimilarity = null; }
    }
  }
  const violations: string[] = [];
  if (std < 12) violations.push("collapse: near-flat luminance distribution");
  if (std > 92 || edgeDensity > 0.58) violations.push("collapse: excessive high-frequency edges");
  if (saturationMean > 0.92) violations.push("collapse: extreme saturation");
  if (pseudoTextRisk > 0.11) violations.push("fake-text-risk: dense short high-contrast strokes");
  if (ocrTokens.length > 0) violations.push(`fake-text-ocr: ${ocrTokens.join(" ")}`);
  if (identitySimilarity !== null && identitySimilarity < 0.12) violations.push(`visual-identity-embedding: similarity ${identitySimilarity.toFixed(3)}`);
  return { assetId, passed: violations.length === 0, metrics: { luminanceStdDev: std, saturationMean, edgeDensity, pseudoTextRisk, ocrTokens, identitySimilarity }, violations };
}
