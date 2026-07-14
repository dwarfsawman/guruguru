/**
 * LLM の人物配置指示(`PanelCastSpec.bbox/pose/gazeTarget` + `shot.size`)から OpenPose-18
 * 骨格を決定的に復元する(ネームv4 D4)。LLM に座標や骨格を出させず、テンプレートポーズの
 * キーワード選択 → shot 別可視範囲 → bbox フィット → 視線による左右反転、で組み立てる。
 * 生成画像を骨格で縛りすぎると漫画的デフォルメが死ぬため、適用の強弱は呼び出し側の
 * poseControl(strength/endPercent)が受け持つ。
 */
import type { PanelSpec } from "../shared/mangaPlanV2";
import {
  findPosePreset,
  flipPosePresetPoints,
  matchPosePresetId,
  presetToPosePoints,
  visibleJointsForPoseMode,
  visibleJointsForShotSize
} from "../shared/posePresetLibrary";
import { MAX_POSE_COUNT, type PosePoint } from "../shared/poseTypes";

export type PoseControlMode = "full" | "upper" | "face";

export interface ReconstructedPanelPoses {
  /** 画像 px 座標の OpenPose 18点 × 人数(≦ MAX_POSE_COUNT)。 */
  poses: PosePoint[][];
  /** 選択されたプリセット id(人数分、来歴・テスト用)。 */
  presetIds: string[];
}

/**
 * cast 1人分の向き: gazeTarget のヒント → 他 cast との相対位置、の順で決める。
 * どちらとも言えない単独コマは neutral(プリセットをそのまま使い、反転しない)。
 */
function facingDirection(
  member: PanelSpec["cast"][number],
  others: PanelSpec["cast"],
  panel: PanelSpec
): "left" | "right" | "neutral" {
  const gaze = member.gazeTarget?.toLocaleLowerCase() ?? "";
  if (/\bleft\b/u.test(gaze)) return "left";
  if (/\bright\b/u.test(gaze)) return "right";
  const selfCenter = member.bbox.x + member.bbox.width / 2;
  // gazeTarget が他の登場人物を指すなら、その相対位置を向く。
  const target = others.find((other) =>
    other.characterId !== member.characterId && gaze && gaze.includes(other.characterId.toLocaleLowerCase())
  ) ?? others.find((other) => other.characterId !== member.characterId && other.characterId === panel.shot.focalSubjectId);
  const reference = target ?? others.find((other) => other.characterId !== member.characterId);
  if (reference) {
    return reference.bbox.x + reference.bbox.width / 2 < selfCenter ? "left" : "right";
  }
  return "neutral";
}

/**
 * PanelSpec から骨格を復元する。骨格なし(null)の条件:
 * insert ショット / 無人コマ / 5人以上(MAX_POSE_COUNT 超は配置の信頼性が低い)。
 */
export function reconstructPanelPoses(
  panel: PanelSpec,
  widthPx: number,
  heightPx: number,
  mode: PoseControlMode = "full"
): ReconstructedPanelPoses | null {
  if (panel.shot.size === "insert") return null;
  const cast = panel.cast;
  if (cast.length === 0 || cast.length > MAX_POSE_COUNT) return null;
  if (!(widthPx > 0) || !(heightPx > 0)) return null;
  const shotVisible = visibleJointsForShotSize(panel.shot.size);
  const modeVisible = visibleJointsForPoseMode(mode);
  const poses: PosePoint[][] = [];
  const presetIds: string[] = [];
  for (const member of cast) {
    const presetId = matchPosePresetId([member.pose ?? "", member.action ?? ""].join(" "));
    const preset = findPosePreset(presetId) ?? findPosePreset("standing")!;
    // プリセットは正面(中立)または左向き基準。右向きが必要なときだけ水平反転する。
    const direction = facingDirection(member, cast, panel);
    const oriented = direction === "right" ? flipPosePresetPoints(preset.points) : preset.points;
    const points = presetToPosePoints(oriented, [shotVisible, modeVisible]);
    // 可視関節の外接箱を cast.bbox(px)へアスペクト維持で contain フィットし中央寄せする。
    const visiblePoints = points.filter((point) => point.visible);
    if (visiblePoints.length === 0) continue;
    const minX = Math.min(...visiblePoints.map((point) => point.x));
    const maxX = Math.max(...visiblePoints.map((point) => point.x));
    const minY = Math.min(...visiblePoints.map((point) => point.y));
    const maxY = Math.max(...visiblePoints.map((point) => point.y));
    const contentWidth = Math.max(1e-6, maxX - minX);
    const contentHeight = Math.max(1e-6, maxY - minY);
    const targetX = member.bbox.x * widthPx;
    const targetY = member.bbox.y * heightPx;
    const targetWidth = Math.max(1, member.bbox.width * widthPx);
    const targetHeight = Math.max(1, member.bbox.height * heightPx);
    const scale = Math.min(targetWidth / contentWidth, targetHeight / contentHeight);
    const offsetX = targetX + (targetWidth - contentWidth * scale) / 2;
    const offsetY = targetY + (targetHeight - contentHeight * scale) / 2;
    poses.push(points.map((point) => ({
      x: offsetX + (point.x - minX) * scale,
      y: offsetY + (point.y - minY) * scale,
      visible: point.visible
    })));
    presetIds.push(preset.id);
  }
  if (poses.length === 0) return null;
  return { poses, presetIds };
}
