/**
 * 吹き出し(BalloonObject)の本体+しっぽの SVG パス生成(Docs/Feature-CGCollectionSuite.md P3)。
 * 純ロジックのみ(DOM・db 非依存) -- クライアント(`pagePanelLightboxView.ts`)とサーバ
 * (`openRasterExport.ts`)の両方がここの関数を呼ぶことで、プレビューと書き出しの見た目を一致させる
 * (`textSvg.ts` と同じ「共有 SVG フラグメント生成」方針)。
 *
 * 座標系は `pageObjects.ts` と同じ page-width 単位・**オブジェクト中心=原点**(回転前)。
 * `renderBalloonSvg` は `renderTextSvg` と同じ形の API(anchor + rotation を受け取り、
 * `<g transform="translate(...) rotate(...)">` で包む)にしてあるので、呼び出し側の使い方も揃う。
 *
 * しっぽの本体境界交点は「パス交差の厳密解」ではなく「中心→tip 方向の楕円境界点」で近似する
 * (5形状とも rx=size.x/2, ry=size.y/2 の楕円で近似。角丸/雲形/フラッシュの実際の輪郭とは
 * 多少ズレるが、実用上の見た目には影響しない -- Docs 記載の設計判断どおり)。
 *
 * 根本の継ぎ目を消す合成順(擬似的な union): しっぽを stroke 付きで先に描き→本体を fill+stroke→
 * しっぽの fill だけをもう一度重ねる。これで本体の stroke がしっぽの付け根を横切って見えるのを防ぐ
 * (thought の円列は本体と重ならない想定なのでこの継ぎ目処理は不要)。
 */
import {
  PAGE_OBJECT_MIN_SIZE,
  contentMaxWidth,
  type BalloonObject,
  type BalloonShape,
  type BalloonTail,
  type PageVec,
  type TextDirection
} from "./pageObjects";

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "0";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- 本体形状(バンプ/トゲ数はサイズから決める) ---

/** cloud/thought のもくもくバンプ数(8〜16、サイズが大きいほど多い)。 */
export function balloonBumpCount(size: PageVec): number {
  const scale = Math.max(0, size.x) + Math.max(0, size.y);
  return Math.round(clamp(8 + scale * 10, 8, 16));
}

/** jagged のトゲ数(12〜24、サイズが大きいほど多い)。 */
export function balloonSpikeCount(size: PageVec): number {
  const scale = Math.max(0, size.x) + Math.max(0, size.y);
  return Math.round(clamp(12 + scale * 10, 12, 24));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** 楕円(ベジェ4分割近似)の閉パス。中心=原点。 */
function ellipsePath(rx: number, ry: number): string {
  const k = 0.5522847498307936;
  return [
    `M ${fmt(-rx)} 0`,
    `C ${fmt(-rx)} ${fmt(-ry * k)}, ${fmt(-rx * k)} ${fmt(-ry)}, 0 ${fmt(-ry)}`,
    `C ${fmt(rx * k)} ${fmt(-ry)}, ${fmt(rx)} ${fmt(-ry * k)}, ${fmt(rx)} 0`,
    `C ${fmt(rx)} ${fmt(ry * k)}, ${fmt(rx * k)} ${fmt(ry)}, 0 ${fmt(ry)}`,
    `C ${fmt(-rx * k)} ${fmt(ry)}, ${fmt(-rx)} ${fmt(ry * k)}, ${fmt(-rx)} 0`,
    "Z"
  ].join(" ");
}

/** 角丸矩形の閉パス。角の半径は min(rx,ry) の半分(円弧、非楕円弧)。中心=原点。 */
function roundedRectPath(rx: number, ry: number): string {
  const r = Math.min(rx, ry) * 0.5;
  const x0 = -rx;
  const y0 = -ry;
  const x1 = rx;
  const y1 = ry;
  return [
    `M ${fmt(x0 + r)} ${fmt(y0)}`,
    `L ${fmt(x1 - r)} ${fmt(y0)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x1)} ${fmt(y0 + r)}`,
    `L ${fmt(x1)} ${fmt(y1 - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x1 - r)} ${fmt(y1)}`,
    `L ${fmt(x0 + r)} ${fmt(y1)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x0)} ${fmt(y1 - r)}`,
    `L ${fmt(x0)} ${fmt(y0 + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x0 + r)} ${fmt(y0)}`,
    "Z"
  ].join(" ");
}

/** もくもく雲形(cloud/thought 共通の輪郭)。N 個の楕円上の点を二次ベジェで外向きに膨らませてつなぐ。 */
function cloudPath(rx: number, ry: number, bumps: number): string {
  const count = Math.max(3, Math.round(bumps));
  const points: PageVec[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    points.push({ x: rx * Math.cos(t), y: ry * Math.sin(t) });
  }
  const bumpOut = 1.32;
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 0; i < count; i += 1) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % count]!;
    const cx = ((p0.x + p1.x) / 2) * bumpOut;
    const cy = ((p0.y + p1.y) / 2) * bumpOut;
    d += ` Q ${fmt(cx)} ${fmt(cy)} ${fmt(p1.x)} ${fmt(p1.y)}`;
  }
  return `${d} Z`;
}

/** ギザギザ(フラッシュ/叫び)。外径/内径を交互に折れ線でつなぐ。内径 = 外径 * 0.78(「0.8 程度」)。 */
function jaggedPath(rx: number, ry: number, spikes: number): string {
  const innerRatio = 0.78;
  const count = Math.max(6, Math.round(spikes)) * 2;
  const points: PageVec[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : innerRatio;
    points.push({ x: rx * r * Math.cos(t), y: ry * r * Math.sin(t) });
  }
  const [first, ...rest] = points;
  return `M ${fmt(first!.x)} ${fmt(first!.y)} ${rest.map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`).join(" ")} Z`;
}

/** 吹き出し本体の閉パス(中心=原点、page 単位)。 */
export function balloonBodyPath(shape: BalloonShape, size: PageVec): string {
  const rx = Math.max(1e-6, size.x / 2);
  const ry = Math.max(1e-6, size.y / 2);
  switch (shape) {
    case "rounded":
      return roundedRectPath(rx, ry);
    case "cloud":
    case "thought":
      return cloudPath(rx, ry, balloonBumpCount(size));
    case "jagged":
      return jaggedPath(rx, ry, balloonSpikeCount(size));
    case "ellipse":
    default:
      return ellipsePath(rx, ry);
  }
}

// --- しっぽ ---

/** 中心から見た方向単位ベクトル。tip が原点に極めて近い(しっぽ未設定直後の既定生成前)場合は下向き。 */
function tailDirection(tip: PageVec): PageVec {
  const len = Math.hypot(tip.x, tip.y);
  if (!(len > 1e-9)) {
    return { x: 0, y: 1 };
  }
  return { x: tip.x / len, y: tip.y / len };
}

/**
 * 楕円(rx, ry)の中心から方向(dirX, dirY)へ伸ばした半直線と楕円境界の交点。
 * 5形状すべての「本体境界との交点」近似としてこれを使う(パス交差の厳密解は取らない)。
 */
export function ellipseBoundaryPoint(rx: number, ry: number, dirX: number, dirY: number): PageVec {
  const rxs = Math.max(1e-6, rx);
  const rys = Math.max(1e-6, ry);
  const denom = Math.sqrt((dirX / rxs) ** 2 + (dirY / rys) ** 2);
  if (!(denom > 1e-9)) {
    return { x: 0, y: -rys };
  }
  const scale = 1 / denom;
  return { x: dirX * scale, y: dirY * scale };
}

export interface BalloonTailTriangle {
  kind: "triangle";
  /** 三角形の頂点(根本1, tip, 根本2)。 */
  points: [PageVec, PageVec, PageVec];
  /** 閉パス d(fill/stroke 両方に使う)。 */
  d: string;
}

export interface BalloonTailCircles {
  kind: "circles";
  /** 本体寄りから tip 側へ向かって並ぶ円(半径は先端に近いほど小さい)。 */
  circles: { cx: number; cy: number; r: number }[];
}

export type BalloonTailShape = BalloonTailTriangle | BalloonTailCircles;

function thoughtCircles(root: PageVec, tip: PageVec, width: number): { cx: number; cy: number; r: number }[] {
  const baseR = Math.max(0.003, width / 2);
  const fractions = [0.28, 0.6, 0.9];
  const radii = [baseR, baseR * 0.62, baseR * 0.34];
  return fractions.map((fraction, index) => ({
    cx: root.x + (tip.x - root.x) * fraction,
    cy: root.y + (tip.y - root.y) * fraction,
    r: radii[index]!
  }));
}

/**
 * しっぽの形状。ellipse/rounded/cloud/jagged は本体境界〜tip の三角形、thought は
 * 本体から tip へ向かって小さくなる円 3 個(本体と重ならない想定なので継ぎ目処理は不要)。
 *
 * 根本2点は「root±接線方向オフセット」ではなく、**楕円境界上の点をさらに中心側へ押し込んだ位置**にする。
 * 接線上に置くと三角形が本体と1点でしか接せず(接線は凸形状の外側)、継ぎ目消しの
 * 「しっぽ fill 再重ね」が本体 stroke を覆えない -- 根本エッジと本体輪郭の両方が線として
 * 見えてしまう(2026-07-11 報告)。三角形の根本側を本体内部へ食い込ませることで、
 * 本体 stroke の交差部分が tailFront の fill で確実に覆われるようにする。
 * strokeWidth は食い込み量の下限(stroke の外側半分まで覆う)に使う。
 */
export function balloonTailPath(shape: BalloonShape, size: PageVec, tail: BalloonTail, strokeWidth = 0): BalloonTailShape {
  const rx = Math.max(1e-6, size.x / 2);
  const ry = Math.max(1e-6, size.y / 2);
  const dir = tailDirection(tail.tip);
  const root = ellipseBoundaryPoint(rx, ry, dir.x, dir.y);
  if (shape === "thought") {
    return { kind: "circles", circles: thoughtCircles(root, tail.tip, tail.width) };
  }
  const perp = { x: -dir.y, y: dir.x };
  const halfWidth = Math.max(1e-6, tail.width) / 2;
  const cornerFor = (sign: number): PageVec => {
    // 接線上の仮点(root±perp·halfWidth)の方向で楕円境界へ投影し直す(接線の外側ズレを消す)。
    const px = root.x + perp.x * halfWidth * sign;
    const py = root.y + perp.y * halfWidth * sign;
    const len = Math.hypot(px, py);
    const boundary = len > 1e-9 ? ellipseBoundaryPoint(rx, ry, px / len, py / len) : root;
    const boundaryLen = Math.hypot(boundary.x, boundary.y);
    // 中心側への食い込み: stroke 幅+しっぽ幅比例のマージン。jagged は内径 0.78 の凹みが
    // 楕円近似より内側に来るため、追加で境界距離の 1/4 を食い込ませる。中心を跨がないよう上限あり。
    const bite = Math.min(
      boundaryLen * 0.6,
      strokeWidth * 1.5 + halfWidth * 0.25 + (shape === "jagged" ? boundaryLen * 0.25 : 0)
    );
    const scale = boundaryLen > 1e-9 ? (boundaryLen - bite) / boundaryLen : 1;
    return { x: boundary.x * scale, y: boundary.y * scale };
  };
  const baseA = cornerFor(1);
  const baseB = cornerFor(-1);
  const tip: PageVec = { x: tail.tip.x, y: tail.tip.y };
  const d = `M ${fmt(baseA.x)} ${fmt(baseA.y)} L ${fmt(tip.x)} ${fmt(tip.y)} L ${fmt(baseB.x)} ${fmt(baseB.y)} Z`;
  return { kind: "triangle", points: [baseA, tip, baseB], d };
}

// --- content(内包テキスト)の折り返し幅 ---

/**
 * 形状ごとの内接矩形係数(`contentMaxWidth` の一般パディングに追加で掛ける)。
 * ellipse は 1/√2(正方形近似での内接矩形)、rounded は角に少し食われる分やや小さく、
 * cloud/jagged/thought はもくもく/トゲで凹凸がある分さらに 0.8 掛け。
 */
const BALLOON_INSCRIBED_FACTOR: Record<BalloonShape, number> = {
  ellipse: 1 / Math.SQRT2,
  rounded: 0.86,
  cloud: (1 / Math.SQRT2) * 0.8,
  jagged: (1 / Math.SQRT2) * 0.8,
  thought: (1 / Math.SQRT2) * 0.8
};

/** balloon.content の折り返し幅(page 単位)。box の `contentMaxWidth` に形状ごとの内接係数を追加で掛ける。 */
export function balloonContentMaxWidth(shape: BalloonShape, size: PageVec, direction: TextDirection): number {
  const base = contentMaxWidth(size, direction);
  const factor = BALLOON_INSCRIBED_FACTOR[shape] ?? 1;
  return Math.max(PAGE_OBJECT_MIN_SIZE, base * factor);
}

// --- SVG 合成(本体+しっぽ、継ぎ目を消す合成順) ---

export type BalloonSvgInput = Pick<BalloonObject, "shape" | "size" | "tail" | "fill" | "strokeColor" | "strokeWidth">;

/**
 * 吹き出し本体+しっぽの SVG フラグメント(`renderTextSvg` と同じ API 形: anchor+rotation で包む)。
 * `pagePanelLightboxView.ts`(プレビュー)と `openRasterExport.ts`(書き出し)の両方がこれを呼ぶ
 * ことで見た目を一致させる。継ぎ目を消す合成順は先頭のコメント参照。
 */
export function renderBalloonSvg(object: BalloonSvgInput, anchor: PageVec, rotation: number): string {
  const bodyD = balloonBodyPath(object.shape, object.size);
  const fill = escapeAttr(object.fill);
  const stroke = escapeAttr(object.strokeColor);
  const strokeWidth = fmt(object.strokeWidth);
  const tailShape = object.tail ? balloonTailPath(object.shape, object.size, object.tail, object.strokeWidth) : null;

  let tailBack = "";
  let tailFront = "";
  let circles = "";
  if (tailShape?.kind === "triangle") {
    tailBack = `<path d="${tailShape.d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" />`;
    tailFront = `<path d="${tailShape.d}" fill="${fill}" stroke="none" />`;
  } else if (tailShape?.kind === "circles") {
    circles = tailShape.circles
      .map(
        (circle) =>
          `<circle cx="${fmt(circle.cx)}" cy="${fmt(circle.cy)}" r="${fmt(circle.r)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />`
      )
      .join("");
  }
  const body = `<path d="${bodyD}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" />`;
  const deg = (rotation * 180) / Math.PI;
  const groupTransform = `translate(${fmt(anchor.x)} ${fmt(anchor.y)})${deg ? ` rotate(${fmt(deg)})` : ""}`;
  // 継ぎ目消し: しっぽ(stroke 付き)→本体(fill+stroke)→しっぽの fill だけを再度重ねる。
  // thought は circles を本体の後にそのまま重ねるだけ(本体と重ならない想定なので継ぎ目処理は不要)。
  return `<g class="page-object-balloon-shape" transform="${groupTransform}">${tailBack}${body}${tailFront}${circles}</g>`;
}
