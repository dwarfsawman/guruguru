/**
 * テンプレートポーズライブラリ(ネームv4 D4)。正規化座標(0..1 の person box)の
 * OpenPose-18 ポーズを持ち、監督出力の自由文 `pose`/`action` からキーワードマッチで選ぶ。
 * LLM に座標や骨格を出させないための決定的な語彙。座標系は x=右+, y=下+。
 * 「r」= 本人の右(正面向きでは画面左)。OpenPose 学習画像の標準と同じ。
 */
import { OPENPOSE_JOINT_COUNT, type PosePoint } from "./poseTypes";

export interface PosePreset {
  id: string;
  /** 0..1 person-box 空間の 18 点。visible=false の関節は「その向きでは見えない」意味。 */
  points: Array<{ x: number; y: number; visible?: boolean }>;
}

type P = Array<{ x: number; y: number; visible?: boolean }>;

function pose(points: P): P {
  if (points.length !== OPENPOSE_JOINT_COUNT) throw new Error(`pose preset must have ${OPENPOSE_JOINT_COUNT} joints`);
  return points;
}

// index: 0 nose, 1 neck, 2 rShoulder, 3 rElbow, 4 rWrist, 5 lShoulder, 6 lElbow, 7 lWrist,
//        8 rHip, 9 rKnee, 10 rAnkle, 11 lHip, 12 lKnee, 13 lAnkle, 14 rEye, 15 lEye, 16 rEar, 17 lEar

const STANDING = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.4, y: 0.34 }, { x: 0.39, y: 0.46 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

const SITTING = pose([
  { x: 0.5, y: 0.14 }, { x: 0.5, y: 0.24 },
  { x: 0.42, y: 0.25 }, { x: 0.41, y: 0.38 }, { x: 0.45, y: 0.5 },
  { x: 0.58, y: 0.25 }, { x: 0.59, y: 0.38 }, { x: 0.55, y: 0.5 },
  { x: 0.45, y: 0.55 }, { x: 0.41, y: 0.66 }, { x: 0.42, y: 0.86 },
  { x: 0.55, y: 0.55 }, { x: 0.59, y: 0.66 }, { x: 0.58, y: 0.86 },
  { x: 0.47, y: 0.125 }, { x: 0.53, y: 0.125 }, { x: 0.44, y: 0.135 }, { x: 0.56, y: 0.135 }
]);

const WALKING = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.38, y: 0.33 }, { x: 0.34, y: 0.44 },
  { x: 0.58, y: 0.21 }, { x: 0.62, y: 0.35 }, { x: 0.66, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.4, y: 0.68 }, { x: 0.36, y: 0.88 },
  { x: 0.56, y: 0.5 }, { x: 0.6, y: 0.7 }, { x: 0.64, y: 0.89 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

const RUNNING = pose([
  { x: 0.54, y: 0.11 }, { x: 0.52, y: 0.21 },
  { x: 0.44, y: 0.22 }, { x: 0.36, y: 0.3 }, { x: 0.3, y: 0.22 },
  { x: 0.6, y: 0.22 }, { x: 0.66, y: 0.32 }, { x: 0.72, y: 0.42 },
  { x: 0.46, y: 0.5 }, { x: 0.34, y: 0.62 }, { x: 0.28, y: 0.82 },
  { x: 0.56, y: 0.5 }, { x: 0.66, y: 0.66 }, { x: 0.72, y: 0.86 },
  { x: 0.51, y: 0.095 }, { x: 0.57, y: 0.095 }, { x: 0.48, y: 0.105 }, { x: 0.6, y: 0.105 }
]);

const CROUCHING = pose([
  { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.4 },
  { x: 0.42, y: 0.41 }, { x: 0.4, y: 0.53 }, { x: 0.42, y: 0.64 },
  { x: 0.58, y: 0.41 }, { x: 0.6, y: 0.53 }, { x: 0.58, y: 0.64 },
  { x: 0.44, y: 0.62 }, { x: 0.38, y: 0.78 }, { x: 0.42, y: 0.9 },
  { x: 0.56, y: 0.62 }, { x: 0.62, y: 0.78 }, { x: 0.58, y: 0.9 },
  { x: 0.47, y: 0.285 }, { x: 0.53, y: 0.285 }, { x: 0.44, y: 0.295 }, { x: 0.56, y: 0.295 }
]);

const POINTING = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.3, y: 0.22 }, { x: 0.18, y: 0.21 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

const ARMS_CROSSED = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.4, y: 0.33 }, { x: 0.55, y: 0.35 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.33 }, { x: 0.45, y: 0.35 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

const LYING = pose([
  { x: 0.88, y: 0.47 }, { x: 0.8, y: 0.5 },
  { x: 0.8, y: 0.44 }, { x: 0.68, y: 0.42 }, { x: 0.58, y: 0.44 },
  { x: 0.8, y: 0.56 }, { x: 0.68, y: 0.58 }, { x: 0.58, y: 0.56 },
  { x: 0.55, y: 0.46 }, { x: 0.38, y: 0.44 }, { x: 0.2, y: 0.46 },
  { x: 0.55, y: 0.54 }, { x: 0.38, y: 0.56 }, { x: 0.2, y: 0.54 },
  { x: 0.9, y: 0.44 }, { x: 0.9, y: 0.5 }, { x: 0.86, y: 0.42 }, { x: 0.86, y: 0.52 }
]);

/** 背面: 顔のキーポイントは見えない(ears のみ)。左右は鏡像(本人の右が画面右)。 */
const BACK_VIEW = pose([
  { x: 0.5, y: 0.1, visible: false }, { x: 0.5, y: 0.2 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.42, y: 0.21 }, { x: 0.4, y: 0.34 }, { x: 0.39, y: 0.46 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.47, y: 0.085, visible: false }, { x: 0.53, y: 0.085, visible: false },
  { x: 0.45, y: 0.095 }, { x: 0.55, y: 0.095 }
]);

/** 画面左向きの横顔・立ち姿(見える側=本人の右)。 */
const PROFILE_LEFT = pose([
  { x: 0.43, y: 0.095 }, { x: 0.5, y: 0.2 },
  { x: 0.49, y: 0.21 }, { x: 0.45, y: 0.34 }, { x: 0.41, y: 0.45 },
  { x: 0.52, y: 0.21 }, { x: 0.5, y: 0.34 }, { x: 0.47, y: 0.46 },
  { x: 0.5, y: 0.5 }, { x: 0.47, y: 0.7 }, { x: 0.49, y: 0.9 },
  { x: 0.53, y: 0.5 }, { x: 0.52, y: 0.7 }, { x: 0.54, y: 0.9 },
  { x: 0.45, y: 0.08 }, { x: 0.5, y: 0.08, visible: false }, { x: 0.51, y: 0.09 }, { x: 0.55, y: 0.095, visible: false }
]);

/**
 * 腕の形を持つプリセット群。
 *
 * プリセットは全身の姿勢を持つが**腕の詳細を持たない**。アンカーは頭と胴の相似変換なので、
 * 腕は設計から一切影響を受けない。実測では sitting/standing/walking は正しく当たっているのに
 * 「両肘を膝に」「脚立を脇に抱える」「桶を腰に当てる」の3件とも腕だけが再現されず全滅した。
 * 腕の配置は姿勢そのものなので、語彙で選べるプリセットとして持たせる。
 */
const ELBOWS_ON_KNEES = pose([
  { x: 0.5, y: 0.16 }, { x: 0.5, y: 0.26 },
  { x: 0.42, y: 0.27 }, { x: 0.4, y: 0.42 }, { x: 0.43, y: 0.56 },
  { x: 0.58, y: 0.27 }, { x: 0.6, y: 0.42 }, { x: 0.57, y: 0.56 },
  { x: 0.45, y: 0.56 }, { x: 0.42, y: 0.66 }, { x: 0.43, y: 0.87 },
  { x: 0.55, y: 0.56 }, { x: 0.58, y: 0.66 }, { x: 0.57, y: 0.87 },
  { x: 0.47, y: 0.145 }, { x: 0.53, y: 0.145 }, { x: 0.44, y: 0.155 }, { x: 0.56, y: 0.155 }
]);

/** 片腕で荷物を脇に抱える。抱えた側(本人の右)の肘を締め、手首を腰の高さへ。 */
const CARRY_UNDER_ARM = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.38, y: 0.33 }, { x: 0.36, y: 0.44 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

/** 腰の高さで荷物を体側へ寄せて持つ。両手首を腰骨の外側へ置く。 */
const HOLD_AT_HIP = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.38, y: 0.34 }, { x: 0.41, y: 0.48 },
  { x: 0.58, y: 0.21 }, { x: 0.62, y: 0.34 }, { x: 0.59, y: 0.48 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

/** 片手の平を自分の胸へ当てる。当てた側(本人の右)の手首を胸骨の高さへ寄せる。 */
const HAND_ON_CHEST = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.36, y: 0.31 }, { x: 0.47, y: 0.3 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

/** 片手の平を正面の面(壁など)へ当てる。腕を前へ伸ばし、手首を肩の高さへ置く。 */
const PALM_ON_SURFACE = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.33, y: 0.25 }, { x: 0.24, y: 0.22 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

/** 胸の高さで開いた手を差し出す(受け渡し・制止)。前腕を水平に、手首を体の前へ。 */
const OPEN_HAND_FORWARD = pose([
  { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 },
  { x: 0.42, y: 0.21 }, { x: 0.36, y: 0.32 }, { x: 0.3, y: 0.29 },
  { x: 0.58, y: 0.21 }, { x: 0.6, y: 0.34 }, { x: 0.61, y: 0.46 },
  { x: 0.44, y: 0.5 }, { x: 0.44, y: 0.7 }, { x: 0.44, y: 0.9 },
  { x: 0.56, y: 0.5 }, { x: 0.56, y: 0.7 }, { x: 0.56, y: 0.9 },
  { x: 0.47, y: 0.085 }, { x: 0.53, y: 0.085 }, { x: 0.44, y: 0.095 }, { x: 0.56, y: 0.095 }
]);

export const POSE_PRESETS: readonly PosePreset[] = [
  { id: "standing", points: STANDING },
  { id: "sitting", points: SITTING },
  { id: "walking", points: WALKING },
  { id: "running", points: RUNNING },
  { id: "crouching", points: CROUCHING },
  { id: "pointing", points: POINTING },
  { id: "arms-crossed", points: ARMS_CROSSED },
  { id: "lying", points: LYING },
  { id: "back-view", points: BACK_VIEW },
  { id: "profile-left", points: PROFILE_LEFT },
  { id: "elbows-on-knees", points: ELBOWS_ON_KNEES },
  { id: "carry-under-arm", points: CARRY_UNDER_ARM },
  { id: "hold-at-hip", points: HOLD_AT_HIP },
  { id: "hand-on-chest", points: HAND_ON_CHEST },
  { id: "palm-on-surface", points: PALM_ON_SURFACE },
  { id: "open-hand-forward", points: OPEN_HAND_FORWARD }
];

export function findPosePreset(id: string): PosePreset | null {
  return POSE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 自由文キーワード → プリセット id。複語パターンを先に判定する(未決#5: 監督出力は英語なので
 * 英語キーワードで開始)。マッチしなければ standing。
 */
const MULTI_WORD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:arms?[- ]?crossed|crossed[- ]?arms?|folded[- ]?arms?|folding (?:her |his |their )?arms)\b/u, "arms-crossed"],
  [/\b(?:from behind|turned away|back view|seen from the back|facing away)\b/u, "back-view"],
  [/\b(?:lying down|lie down|laid out|passed out|collapsed)\b/u, "lying"],
  // 腕の形は全身の姿勢より**先に**判定する。後ろに置くと sits/stands/walks に
  // 飲み込まれ、腕の指定が丸ごと落ちる(実測でこれが起き、3コマが全滅した)。
  [/\belbows? on (?:her |his |their )?knees?\b/u, "elbows-on-knees"],
  [/\b(?:under one arm|under (?:her|his|their) arm|tucked under)\b/u, "carry-under-arm"],
  [/\bagainst (?:her|his|their) hip\b|\b(?:hand|hands) on (?:her|his|their) hips?\b/u, "hold-at-hip"],
  [/\b(?:palm|hand) (?:flat )?(?:against|on|to) (?:her|his|their) (?:own )?chest\b|\bhand over (?:her|his|their) heart\b/u, "hand-on-chest"],
  [/\b(?:palm|hand)s? (?:flat )?(?:against|on|pressed to) the (?:wall|door|glass|window|surface)\b/u, "palm-on-surface"],
  [/\b(?:extends?|holds? out|offers?) (?:an? )?open (?:hand|palm)\b/u, "open-hand-forward"]
];

const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:sits?|sitting|seated|kneel(?:s|ing)?|seiza|chair|bench)\b/u, "sitting"],
  [/\b(?:runs?|running|sprint(?:s|ing)?|dash(?:es|ing)?|rush(?:es|ing)?|chas(?:es|ing))\b/u, "running"],
  [/\b(?:walks?|walking|strid(?:es|ing)|stroll(?:s|ing)?|paces?|pacing|approach(?:es|ing)?)\b/u, "walking"],
  [/\b(?:crouch(?:es|ing)?|squat(?:s|ting)?|duck(?:s|ing)?|huddl(?:es|ing)|cower(?:s|ing)?)\b/u, "crouching"],
  [/\b(?:points?|pointing|reach(?:es|ing)?|extends? (?:a |an |her |his |their )?(?:hand|arm)|grabs? at)\b/u, "pointing"],
  [/\b(?:lies?|lying|sprawl(?:s|ed|ing)?|asleep|sleeping|unconscious)\b/u, "lying"],
  [/\b(?:profile|side view|sideways)\b/u, "profile-left"],
  [/\b(?:stands?|standing|upright|still)\b/u, "standing"]
];

/**
 * 語彙からプリセットを選ぶ。`matched` は**どの規則にも当たらず既定へ落ちた**かを表す。
 *
 * 落ちたことを呼び出し側が知れないと危険で、ControlNet は外れたポーズを忠実に強制する。
 * 実測では「両肘を膝、頭を低く」と書いたコマで既定の立ち姿が当たり、4候補すべてが
 * 同じ誤った姿勢に揃った。**黙って外れたプリセットが当たるのは、ポーズ無指定より悪い。**
 * 呼び出し側はこれを警告として出し、設計者が語彙を選び直せるようにする。
 */
export function matchPosePreset(text: string): { id: string; matched: boolean } {
  const normalized = text.toLocaleLowerCase();
  for (const [pattern, id] of MULTI_WORD_RULES) {
    if (pattern.test(normalized)) return { id, matched: true };
  }
  for (const [pattern, id] of KEYWORD_RULES) {
    if (pattern.test(normalized)) return { id, matched: true };
  }
  return { id: "standing", matched: false };
}

export function matchPosePresetId(text: string): string {
  return matchPosePreset(text).id;
}

/**
 * ポーズを person-box 内で水平反転する。x→1-x に加え、左右の関節ペアを入れ替えて
 * OpenPose の左右ラベル(≒ボーン配色)の意味を保つ。
 */
export function flipPosePresetPoints(points: PosePreset["points"]): PosePreset["points"] {
  const flipped = points.map((point) => ({ ...point, x: 1 - point.x }));
  const swaps: ReadonlyArray<readonly [number, number]> = [
    [2, 5], [3, 6], [4, 7], [8, 11], [9, 12], [10, 13], [14, 15], [16, 17]
  ];
  for (const [a, b] of swaps) {
    const temp = flipped[a]!;
    flipped[a] = flipped[b]!;
    flipped[b] = temp;
  }
  return flipped;
}

/** shot.size 毎に見せる関節(それ以外は visible=false)。null = 全関節。 */
export function visibleJointsForShotSize(size: string): ReadonlySet<number> | null {
  if (size === "close-up") return new Set([0, 1, 2, 5, 14, 15, 16, 17]);
  if (size === "medium") return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 16, 17]);
  return null; // wide / extreme-wide / full → 全身
}

/** poseControl の部分モード(face/upper)毎に見せる関節。null = 全関節。 */
export function visibleJointsForPoseMode(mode: "full" | "upper" | "face"): ReadonlySet<number> | null {
  if (mode === "face") return new Set([0, 1, 14, 15, 16, 17]);
  if (mode === "upper") return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 16, 17]);
  return null;
}

/** プリセット点列を PosePoint 列へ(可視集合の積を適用し、px 座標へはまだ変換しない)。 */
export function presetToPosePoints(
  points: PosePreset["points"],
  visibleSets: Array<ReadonlySet<number> | null>
): PosePoint[] {
  return points.map((point, index) => ({
    x: point.x,
    y: point.y,
    visible: (point.visible ?? true) && visibleSets.every((set) => set === null || set.has(index))
  }));
}
