/**
 * LLM の人物配置指示から OpenPose-18 骨格を決定的に復元する(ネームv4 D4 → ネームポーズレイヤ)。
 * 監督が粗いアンカー(頭・胴の位置)を出したキャラは 2点相似変換フィット、無いキャラは従来どおり
 * テンプレートポーズのキーワード選択 → shot 別可視範囲 → bbox フィット → 視線による左右反転。
 * LLM に 18関節の座標を出させることはしない(Docs/Feature-NamePoseLayer.md)。
 * 生成画像を骨格で縛りすぎると漫画的デフォルメが死ぬため、適用の強弱は呼び出し側の
 * poseControl(strength/endPercent)が受け持つ。
 */
import type { PanelCastPose, PanelSpec } from "../shared/mangaPlanV2";
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

/** 監督LLMの粗いアンカー(パネルローカル 0..1)。head=頭部中心、torso=腰・胴中心。 */
export interface PoseAnchor {
  head: { x: number; y: number };
  torso: { x: number; y: number };
}

export interface ReconstructedPanelPoses {
  /** 画像 px 座標の OpenPose 18点 × 人数(≦ MAX_POSE_COUNT)。 */
  poses: PosePoint[][];
  /** 選択されたプリセット id(人数分、来歴・テスト用)。 */
  presetIds: string[];
}

export interface ReconstructCastPosesOptions {
  /** characterId → アンカー。あるキャラは相似変換フィット、無いキャラは bbox フィット。 */
  anchors?: ReadonlyMap<string, PoseAnchor>;
  /** characterId → レイヤ深度ヒント(大きいほど手前、監督LLMの layer 出力)。 */
  layers?: ReadonlyMap<string, number>;
  /** パネルの縦横比(高さ/幅)。相似変換の歪み防止に使う。既定 1。 */
  aspect?: number;
}

/** アンカーの頭・胴距離がパネル短辺のこの比率未満なら退化とみなし bbox フィットへ落とす。 */
const DEGENERATE_ANCHOR_RATIO = 0.02;

/** 頭部中心の基準に使う関節(nose/eyes/ears)。 */
const HEAD_JOINT_INDEXES = [0, 14, 15, 16, 17] as const;
const R_HIP = 8;
const L_HIP = 11;

interface MemberPoseResult {
  characterId: string;
  points: PosePoint[];
  presetId: string;
  source: "llm" | "reconstructed";
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

/** 向き適用済みプリセット点列から頭部中心(プリセット可視の nose/eyes/ears 重心)を求める。 */
function presetHeadCenter(oriented: ReturnType<typeof flipPosePresetPoints>): { x: number; y: number } {
  const candidates = HEAD_JOINT_INDEXES
    .map((index) => oriented[index]!)
    .filter((point) => point.visible !== false);
  const pool = candidates.length > 0 ? candidates : [oriented[0]!];
  const sum = pool.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / pool.length, y: sum.y / pool.length };
}

/** 可視関節の外接箱を cast.bbox(px)へアスペクト維持で contain フィットし中央寄せする。 */
function fitPointsToBbox(
  points: PosePoint[],
  member: PanelSpec["cast"][number],
  widthPx: number,
  heightPx: number
): PosePoint[] | null {
  const visiblePoints = points.filter((point) => point.visible);
  if (visiblePoints.length === 0) return null;
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
  return points.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
    visible: point.visible
  }));
}

/**
 * アンカー(パネルローカル 0..1 → px 換算)への 2点相似変換フィット。プリセットの
 * 頭部中心→ヒップ中点の線分を head→torso アンカー線分へ写す(回転+一様スケール+平行移動)。
 * アンカー間距離が退化しているときは null(呼び出し側が bbox フィットへ落とす)。
 */
function fitPointsToAnchors(
  points: PosePoint[],
  oriented: ReturnType<typeof flipPosePresetPoints>,
  anchor: PoseAnchor,
  widthPx: number,
  heightPx: number
): PosePoint[] | null {
  const headPx = { x: anchor.head.x * widthPx, y: anchor.head.y * heightPx };
  const torsoPx = { x: anchor.torso.x * widthPx, y: anchor.torso.y * heightPx };
  const anchorVec = { x: torsoPx.x - headPx.x, y: torsoPx.y - headPx.y };
  const anchorLen = Math.hypot(anchorVec.x, anchorVec.y);
  if (anchorLen < DEGENERATE_ANCHOR_RATIO * Math.min(widthPx, heightPx)) return null;
  const headRef = presetHeadCenter(oriented);
  const hipRef = {
    x: (oriented[R_HIP]!.x + oriented[L_HIP]!.x) / 2,
    y: (oriented[R_HIP]!.y + oriented[L_HIP]!.y) / 2
  };
  const presetVec = { x: hipRef.x - headRef.x, y: hipRef.y - headRef.y };
  const presetLen = Math.hypot(presetVec.x, presetVec.y);
  if (presetLen < 1e-6) return null;
  const scale = anchorLen / presetLen;
  const rotation = Math.atan2(anchorVec.y, anchorVec.x) - Math.atan2(presetVec.y, presetVec.x);
  const cos = Math.cos(rotation) * scale;
  const sin = Math.sin(rotation) * scale;
  return points.map((point) => {
    const dx = point.x - headRef.x;
    const dy = point.y - headRef.y;
    return {
      x: headPx.x + dx * cos - dy * sin,
      y: headPx.y + dx * sin + dy * cos,
      visible: point.visible
    };
  });
}

/**
 * PanelSpec から骨格を復元する共通コア。骨格なし(null)の条件:
 * insert ショット / 無人コマ / 5人以上(MAX_POSE_COUNT 超は配置の信頼性が低い)。
 */
function reconstructMemberPoses(
  panel: PanelSpec,
  widthPx: number,
  heightPx: number,
  mode: PoseControlMode,
  anchors?: ReadonlyMap<string, PoseAnchor>
): MemberPoseResult[] | null {
  if (panel.shot.size === "insert") return null;
  const cast = panel.cast;
  if (cast.length === 0 || cast.length > MAX_POSE_COUNT) return null;
  if (!(widthPx > 0) || !(heightPx > 0)) return null;
  const shotVisible = visibleJointsForShotSize(panel.shot.size);
  const modeVisible = visibleJointsForPoseMode(mode);
  const results: MemberPoseResult[] = [];
  for (const member of cast) {
    const presetId = matchPosePresetId([member.pose ?? "", member.action ?? ""].join(" "));
    const preset = findPosePreset(presetId) ?? findPosePreset("standing")!;
    // プリセットは正面(中立)または左向き基準。右向きが必要なときだけ水平反転する。
    const direction = facingDirection(member, cast, panel);
    const oriented = direction === "right" ? flipPosePresetPoints(preset.points) : preset.points;
    const points = presetToPosePoints(oriented, [shotVisible, modeVisible]);
    const anchor = anchors?.get(member.characterId);
    const anchored = anchor ? fitPointsToAnchors(points, oriented, anchor, widthPx, heightPx) : null;
    const fitted = anchored ?? fitPointsToBbox(points, member, widthPx, heightPx);
    if (!fitted) continue;
    results.push({
      characterId: member.characterId,
      points: fitted,
      presetId: preset.id,
      source: anchored ? "llm" : "reconstructed"
    });
  }
  if (results.length === 0) return null;
  return results;
}

/** 従来API: 画像 px 座標の骨格列(生成時のオンザフライ復元、旧planフォールバック)。 */
export function reconstructPanelPoses(
  panel: PanelSpec,
  widthPx: number,
  heightPx: number,
  mode: PoseControlMode = "full",
  anchors?: ReadonlyMap<string, PoseAnchor>
): ReconstructedPanelPoses | null {
  const results = reconstructMemberPoses(panel, widthPx, heightPx, mode, anchors);
  if (!results) return null;
  return {
    poses: results.map((result) => result.points),
    presetIds: results.map((result) => result.presetId)
  };
}

/**
 * ネームポーズレイヤ用: パネルローカル正規化(0..1)の PanelCastPose 列を組む。
 * depth は「layers ヒント > focalSubject 最前面 > cast 順」の序列を 0..n-1 へ割り直す
 * (昇順=奥→手前)。shot 由来の可視マスクは焼き込み、poseControl の mode マスクは
 * 生成時に交差適用する(保存骨格は full 相当)。
 */
export function reconstructCastPoses(
  panel: PanelSpec,
  options: ReconstructCastPosesOptions = {}
): PanelCastPose[] | null {
  const aspect = options.aspect !== undefined && Number.isFinite(options.aspect) && options.aspect > 0
    ? options.aspect
    : 1;
  const widthPx = 1000;
  const heightPx = 1000 * aspect;
  const results = reconstructMemberPoses(panel, widthPx, heightPx, "full", options.anchors);
  if (!results) return null;
  const rankOf = (characterId: string, index: number): number => {
    const layer = options.layers?.get(characterId);
    if (layer !== undefined && Number.isFinite(layer)) return layer * 1000 + index;
    return (characterId === panel.shot.focalSubjectId ? 500 : 0) + index;
  };
  const ordered = results
    .map((result, index) => ({ result, rank: rankOf(result.characterId, index) }))
    .sort((a, b) => a.rank - b.rank);
  return ordered.map(({ result }, depth) => ({
    characterId: result.characterId,
    depth,
    joints: result.points.map((point) => ({
      x: point.x / widthPx,
      y: point.y / heightPx,
      visible: point.visible
    })),
    source: result.source,
    presetId: result.presetId
  }));
}
