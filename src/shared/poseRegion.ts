/**
 * キャラ別マスクLoRA基盤(Docs/Feature-NamePoseLayer.md)。骨格(パネルローカル 0..1 の
 * OpenPose-18)からキャラの占有領域を近似する pure helper。現時点で生成には未接続 —
 * 将来 regional LoRA / `ReferenceSpec.targetRegion` / マスク添付へ流す入口として置く。
 */
import type { NormalizedBox } from "./mangaPlanV2";
import type { PosePoint } from "./poseTypes";

const NECK = 1;
const R_HIP = 8;
const L_HIP = 11;

interface Point {
  x: number;
  y: number;
}

function clampCoord(value: number): number {
  return Math.min(2, Math.max(-1, value));
}

/** 体格スケール: 首→ヒップ中点の距離(胴長)。退化時は可視外接箱の対角から推定する。 */
export function poseBodyScale(joints: readonly PosePoint[]): number {
  const neck = joints[NECK];
  const rHip = joints[R_HIP];
  const lHip = joints[L_HIP];
  // 不可視関節の座標を混ぜない(back-view プリセット等で不可視座標が体格スケールを歪める)。
  // フォールバック側(下)と同じ visible 規則。
  if (neck?.visible && rHip?.visible && lHip?.visible) {
    const torso = Math.hypot((rHip.x + lHip.x) / 2 - neck.x, (rHip.y + lHip.y) / 2 - neck.y);
    if (torso > 1e-6) return torso;
  }
  const visible = joints.filter((joint) => joint.visible);
  if (visible.length < 2) return 0.2;
  const xs = visible.map((joint) => joint.x);
  const ys = visible.map((joint) => joint.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return Math.max(0.05, diagonal * 0.35);
}

/**
 * キャラの占有外接箱(パネルローカル)。可視関節の外接箱へ体格比のマージン
 * (頭上は髪・頭部ぶん広め)を足す。可視関節が無ければ null。
 * 見切れを許すため [-1, 2] へのみクランプし、0..1 には切らない。
 */
export function poseCharacterBounds(joints: readonly PosePoint[]): NormalizedBox | null {
  const visible = joints.filter((joint) => joint.visible);
  if (visible.length === 0) return null;
  const scale = poseBodyScale(joints);
  const sideMargin = scale * 0.45;
  const topMargin = scale * 0.55;
  const bottomMargin = scale * 0.25;
  const minX = clampCoord(Math.min(...visible.map((joint) => joint.x)) - sideMargin);
  const maxX = clampCoord(Math.max(...visible.map((joint) => joint.x)) + sideMargin);
  const minY = clampCoord(Math.min(...visible.map((joint) => joint.y)) - topMargin);
  const maxY = clampCoord(Math.max(...visible.map((joint) => joint.y)) + bottomMargin);
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Andrew's monotone chain による凸包(反時計回り、y-down 座標系では時計回りに見える)。 */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length <= 2) return sorted;
  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * キャラの近似シルエット(凸多角形、パネルローカル)。可視関節を体格比の半径で
 * 4方向へ膨らませた点群の凸包。マスクPNG化・領域重なり判定の素材にする。
 * 可視関節が2点未満なら null。
 */
export function poseCharacterSilhouette(joints: readonly PosePoint[]): Point[] | null {
  const visible = joints.filter((joint) => joint.visible);
  if (visible.length < 2) return null;
  const radius = poseBodyScale(joints) * 0.4;
  const buffered: Point[] = [];
  for (const joint of visible) {
    buffered.push(
      { x: clampCoord(joint.x - radius), y: clampCoord(joint.y) },
      { x: clampCoord(joint.x + radius), y: clampCoord(joint.y) },
      { x: clampCoord(joint.x), y: clampCoord(joint.y - radius) },
      { x: clampCoord(joint.x), y: clampCoord(joint.y + radius) }
    );
  }
  const hull = convexHull(buffered);
  return hull.length >= 3 ? hull : null;
}
