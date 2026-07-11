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
 * しっぽは「本体に三角形を重ねて継ぎ目を fill の再重ねで消す」旧方式ではなく、**本体輪郭を
 * 根本2点で切り開き、そこから直線で tip へ往復する単一の閉パス(union 輪郭)**として生成する
 * (2026-07-11 変更)。根本では輪郭の傾きが非連続(かくっと突き出す形)。単一パスなので
 * 継ぎ目が原理的に存在せず、fill が半透明でも破綻しない。
 *
 * 根本2点の置き方: しっぽ方向の角度 φ を中心に、しっぽ幅から決めた半角 α(方向角空間)だけ
 * 開いた2方向で各形状の輪郭を切る。cloud/jagged はサンプル点列から生成しているため、
 * ギャップ内のサンプル点を除いて繋ぎ直す(根本はサンプル点上)。thought のしっぽは従来どおり
 * 本体と重ならない円列なので、この union 化の対象外。
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

/** 角丸矩形の角半径(円弧、非楕円弧)。 */
function roundedCornerRadius(rx: number, ry: number): number {
  return Math.min(rx, ry) * 0.5;
}

/** 角丸矩形の閉パス。中心=原点。 */
function roundedRectPath(rx: number, ry: number): string {
  const r = roundedCornerRadius(rx, ry);
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

/** cloud/thought のバンプ膨らみ係数(バンプ制御点 = 中点×この係数)。 */
const CLOUD_BUMP_OUT = 1.32;

/** cloud/thought の輪郭サンプル点(楕円上、角度昇順)。 */
function cloudPoints(rx: number, ry: number, bumps: number): PageVec[] {
  const count = Math.max(3, Math.round(bumps));
  const points: PageVec[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    points.push({ x: rx * Math.cos(t), y: ry * Math.sin(t) });
  }
  return points;
}

/** 連続する2サンプル点をもくもくバンプ(外向き二次ベジェ)でつなぐセグメント。 */
function cloudBumpSegment(p0: PageVec, p1: PageVec): string {
  const cx = ((p0.x + p1.x) / 2) * CLOUD_BUMP_OUT;
  const cy = ((p0.y + p1.y) / 2) * CLOUD_BUMP_OUT;
  return ` Q ${fmt(cx)} ${fmt(cy)} ${fmt(p1.x)} ${fmt(p1.y)}`;
}

/** もくもく雲形(cloud/thought 共通の輪郭)。N 個の楕円上の点を二次ベジェで外向きに膨らませてつなぐ。 */
function cloudPath(rx: number, ry: number, bumps: number): string {
  const points = cloudPoints(rx, ry, bumps);
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 0; i < points.length; i += 1) {
    d += cloudBumpSegment(points[i]!, points[(i + 1) % points.length]!);
  }
  return `${d} Z`;
}

/** ギザギザ(フラッシュ/叫び)の頂点列(外径/内径交互、角度昇順)。内径 = 外径 * 0.78(「0.8 程度」)。 */
function jaggedPoints(rx: number, ry: number, spikes: number): PageVec[] {
  const innerRatio = 0.78;
  const count = Math.max(6, Math.round(spikes)) * 2;
  const points: PageVec[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : innerRatio;
    points.push({ x: rx * r * Math.cos(t), y: ry * r * Math.sin(t) });
  }
  return points;
}

/** ギザギザの閉パス。 */
function jaggedPath(rx: number, ry: number, spikes: number): string {
  const [first, ...rest] = jaggedPoints(rx, ry, spikes);
  return `M ${fmt(first!.x)} ${fmt(first!.y)} ${rest.map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`).join(" ")} Z`;
}

/** 吹き出し本体の閉パス(中心=原点、page 単位)。しっぽ無し(またはしっぽが円列の thought)用。 */
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
 * しっぽ幅→ギャップ半角の換算(`tailGap`)と ellipse の輪郭切断に使う。
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

/** 2角の最短角距離 [0, π]。 */
function angularDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) {
    d = Math.PI * 2 - d;
  }
  return d;
}

/** しっぽが本体輪郭を切り開くギャップ(方向角空間)。 */
interface TailGap {
  /** しっぽ方向の角度(atan2、y下向き座標)。 */
  phi: number;
  /** ギャップの半角。しっぽ幅の弦に相当(5°〜60° に clamp)。 */
  alpha: number;
  tip: PageVec;
}

function tailGap(rx: number, ry: number, tail: BalloonTail): TailGap {
  const dir = tailDirection(tail.tip);
  const root = ellipseBoundaryPoint(rx, ry, dir.x, dir.y);
  const rootLen = Math.max(1e-6, Math.hypot(root.x, root.y));
  const halfWidth = Math.max(1e-6, tail.width) / 2;
  const alpha = clamp(Math.asin(clamp(halfWidth / rootLen, 0, 0.95)), Math.PI / 36, Math.PI / 3);
  return { phi: Math.atan2(dir.y, dir.x), alpha, tip: { x: tail.tip.x, y: tail.tip.y } };
}

/**
 * 楕円の union 輪郭。根本2点間を長弧1本(SVG A コマンド)で結ぶ。y下向き座標では
 * atan2 増加方向 = sweep フラグ 1 に一致する(ギャップを避けて反対側を回る)。
 */
function ellipseUnionPath(rx: number, ry: number, gap: TailGap): string {
  const a = ellipseBoundaryPoint(rx, ry, Math.cos(gap.phi + gap.alpha), Math.sin(gap.phi + gap.alpha));
  const b = ellipseBoundaryPoint(rx, ry, Math.cos(gap.phi - gap.alpha), Math.sin(gap.phi - gap.alpha));
  return (
    `M ${fmt(a.x)} ${fmt(a.y)} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${fmt(b.x)} ${fmt(b.y)}` +
    ` L ${fmt(gap.tip.x)} ${fmt(gap.tip.y)} Z`
  );
}

/** 角丸矩形の周回ピース(atan2 増加順、(rx,0) 起点で一周)。 */
interface RoundedPiece {
  kind: "line" | "arc";
  to: PageVec;
}

function roundedRectPieces(rx: number, ry: number, r: number): RoundedPiece[] {
  const x1 = rx;
  const y1 = ry;
  const x0 = -rx;
  const y0 = -ry;
  return [
    { kind: "line", to: { x: x1, y: y1 - r } },
    { kind: "arc", to: { x: x1 - r, y: y1 } },
    { kind: "line", to: { x: x0 + r, y: y1 } },
    { kind: "arc", to: { x: x0, y: y1 - r } },
    { kind: "line", to: { x: x0, y: y0 + r } },
    { kind: "arc", to: { x: x0 + r, y: y0 } },
    { kind: "line", to: { x: x1 - r, y: y0 } },
    { kind: "arc", to: { x: x1, y: y0 + r } },
    { kind: "line", to: { x: x1, y: 0 } }
  ];
}

/** 角丸矩形境界と中心からの半直線(単位方向)の交点と、その点が乗る周回ピース番号。 */
function roundedBoundaryLocate(rx: number, ry: number, r: number, dirX: number, dirY: number): { p: PageVec; piece: number } {
  const t = 1 / Math.max(Math.abs(dirX) / rx, Math.abs(dirY) / ry, 1e-9);
  let p = { x: dirX * t, y: dirY * t };
  if (Math.abs(p.x) > rx - r && Math.abs(p.y) > ry - r) {
    // 角の円弧上: 中心 c 半径 r の円との交点(遠い側の根)。
    const c = { x: Math.sign(p.x) * (rx - r), y: Math.sign(p.y) * (ry - r) };
    const b = dirX * c.x + dirY * c.y;
    const disc = Math.max(0, b * b - (c.x * c.x + c.y * c.y - r * r));
    const s = b + Math.sqrt(disc);
    p = { x: dirX * s, y: dirY * s };
    const piece = c.x > 0 ? (c.y > 0 ? 1 : 7) : c.y > 0 ? 3 : 5;
    return { p, piece };
  }
  if (Math.abs(p.x) >= rx - 1e-9) {
    if (p.x > 0) {
      return { p, piece: p.y >= 0 ? 0 : 8 };
    }
    return { p, piece: 4 };
  }
  return { p, piece: p.y > 0 ? 2 : 6 };
}

/** 角丸矩形の union 輪郭。根本 A からピースを atan2 増加方向へ一周歩いて根本 B まで。 */
function roundedUnionPath(rx: number, ry: number, gap: TailGap): string {
  const r = roundedCornerRadius(rx, ry);
  const pieces = roundedRectPieces(rx, ry, r);
  const a = roundedBoundaryLocate(rx, ry, r, Math.cos(gap.phi + gap.alpha), Math.sin(gap.phi + gap.alpha));
  const b = roundedBoundaryLocate(rx, ry, r, Math.cos(gap.phi - gap.alpha), Math.sin(gap.phi - gap.alpha));
  const emitTo = (piece: RoundedPiece, to: PageVec): string =>
    piece.kind === "line" ? ` L ${fmt(to.x)} ${fmt(to.y)}` : ` A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(to.x)} ${fmt(to.y)}`;
  let d = `M ${fmt(a.p.x)} ${fmt(a.p.y)}`;
  d += emitTo(pieces[a.piece]!, pieces[a.piece]!.to);
  for (let i = (a.piece + 1) % pieces.length; i !== b.piece; i = (i + 1) % pieces.length) {
    d += emitTo(pieces[i]!, pieces[i]!.to);
  }
  d += emitTo(pieces[b.piece]!, b.p);
  return `${d} L ${fmt(gap.tip.x)} ${fmt(gap.tip.y)} Z`;
}

/**
 * 角度昇順サンプル点列から、しっぽギャップ内の点を除いた歩き順(ギャップ直後→直前)の
 * インデックス列を返す。ギャップがサンプル間隔より狭ければ φ に最も近い1点だけを除き、
 * 残りが2点未満にならないようギャップ端から戻す。
 */
function spliceIndices(points: PageVec[], gap: TailGap): number[] {
  const n = points.length;
  const angleAt = (i: number) => Math.atan2(points[i]!.y, points[i]!.x);
  const inGap = points.map((_, i) => angularDistance(angleAt(i), gap.phi) < gap.alpha);
  if (!inGap.some(Boolean)) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < n; i += 1) {
      const d = angularDistance(angleAt(i), gap.phi);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    inGap[best] = true;
  }
  let gapCount = inGap.filter(Boolean).length;
  while (n - gapCount < 2) {
    let far = -1;
    let farDist = -1;
    for (let i = 0; i < n; i += 1) {
      if (inGap[i]) {
        const d = angularDistance(angleAt(i), gap.phi);
        if (d > farDist) {
          farDist = d;
          far = i;
        }
      }
    }
    inGap[far] = false;
    gapCount -= 1;
  }
  // サンプル角は単調なのでギャップは円環上の連続1区間。その直後から直前まで歩く。
  let last = -1;
  for (let i = 0; i < n; i += 1) {
    if (inGap[i] && !inGap[(i + 1) % n]) {
      last = i;
      break;
    }
  }
  let first = -1;
  for (let i = 0; i < n; i += 1) {
    if (inGap[i] && !inGap[(i - 1 + n) % n]) {
      first = i;
      break;
    }
  }
  const iA = (last + 1) % n;
  const iB = (first - 1 + n) % n;
  const order: number[] = [];
  for (let i = iA; ; i = (i + 1) % n) {
    order.push(i);
    if (i === iB || order.length > n) {
      break;
    }
  }
  return order;
}

/** 雲形の union 輪郭。ギャップ内のサンプル点を除き、残りをバンプでつないで根本から tip へ直線往復。 */
function cloudUnionPath(rx: number, ry: number, bumps: number, gap: TailGap): string {
  const points = cloudPoints(rx, ry, bumps);
  const order = spliceIndices(points, gap);
  const start = points[order[0]!]!;
  let d = `M ${fmt(start.x)} ${fmt(start.y)}`;
  for (let k = 1; k < order.length; k += 1) {
    d += cloudBumpSegment(points[order[k - 1]!]!, points[order[k]!]!);
  }
  return `${d} L ${fmt(gap.tip.x)} ${fmt(gap.tip.y)} Z`;
}

/** ギザギザの union 輪郭。根本はトゲの外側頂点(偶数 index)にする(内側頂点始まりは付け根が凹む)。 */
function jaggedUnionPath(rx: number, ry: number, spikes: number, gap: TailGap): string {
  const points = jaggedPoints(rx, ry, spikes);
  let order = spliceIndices(points, gap);
  while (order.length > 2 && order[0]! % 2 === 1) {
    order = order.slice(1);
  }
  while (order.length > 2 && order[order.length - 1]! % 2 === 1) {
    order = order.slice(0, -1);
  }
  const start = points[order[0]!]!;
  const lines = order
    .slice(1)
    .map((i) => `L ${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`)
    .join(" ");
  return `M ${fmt(start.x)} ${fmt(start.y)} ${lines} L ${fmt(gap.tip.x)} ${fmt(gap.tip.y)} Z`;
}

/**
 * 本体+しっぽの単一閉パス(union 輪郭)。根本では輪郭の傾きが非連続(かくっと突き出す形)。
 * thought はしっぽが円列(本体と重ならない)なのでこの関数の対象外 -- 本体パスをそのまま返す。
 */
export function balloonUnionPath(shape: BalloonShape, size: PageVec, tail: BalloonTail): string {
  const rx = Math.max(1e-6, size.x / 2);
  const ry = Math.max(1e-6, size.y / 2);
  if (shape === "thought") {
    return balloonBodyPath(shape, size);
  }
  const gap = tailGap(rx, ry, tail);
  switch (shape) {
    case "rounded":
      return roundedUnionPath(rx, ry, gap);
    case "cloud":
      return cloudUnionPath(rx, ry, balloonBumpCount(size), gap);
    case "jagged":
      return jaggedUnionPath(rx, ry, balloonSpikeCount(size), gap);
    case "ellipse":
    default:
      return ellipseUnionPath(rx, ry, gap);
  }
}

/** thought のしっぽ円列(本体寄りから tip へ向かって小さくなる3円)。 */
export function balloonThoughtCircles(size: PageVec, tail: BalloonTail): { cx: number; cy: number; r: number }[] {
  const rx = Math.max(1e-6, size.x / 2);
  const ry = Math.max(1e-6, size.y / 2);
  const dir = tailDirection(tail.tip);
  const root = ellipseBoundaryPoint(rx, ry, dir.x, dir.y);
  const baseR = Math.max(0.003, tail.width / 2);
  const fractions = [0.28, 0.6, 0.9];
  const radii = [baseR, baseR * 0.62, baseR * 0.34];
  return fractions.map((fraction, index) => ({
    cx: root.x + (tail.tip.x - root.x) * fraction,
    cy: root.y + (tail.tip.y - root.y) * fraction,
    r: radii[index]!
  }));
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

/** 形状内へ文字矩形を安全に収めるための内接係数。自動サイズ/自動フィットでも描画と同じ値を使う。 */
export function balloonInscribedFactor(shape: BalloonShape): number {
  return BALLOON_INSCRIBED_FACTOR[shape] ?? 1;
}

/** balloon.content の折り返し幅(page 単位)。box の `contentMaxWidth` に形状ごとの内接係数を追加で掛ける。 */
export function balloonContentMaxWidth(shape: BalloonShape, size: PageVec, direction: TextDirection): number {
  const base = contentMaxWidth(size, direction);
  const factor = balloonInscribedFactor(shape);
  return Math.max(PAGE_OBJECT_MIN_SIZE, base * factor);
}

// --- SVG 合成 ---

export type BalloonSvgInput = Pick<BalloonObject, "shape" | "size" | "tail" | "fill" | "strokeColor" | "strokeWidth">;

/**
 * 吹き出し本体+しっぽの SVG フラグメント(`renderTextSvg` と同じ API 形: anchor+rotation で包む)。
 * `pagePanelLightboxView.ts`(プレビュー)と `openRasterExport.ts`(書き出し)の両方がこれを呼ぶ
 * ことで見た目を一致させる。しっぽ付きは単一の union 輪郭パス1本(先頭コメント参照)、
 * thought のみ本体+円列。
 */
export function renderBalloonSvg(object: BalloonSvgInput, anchor: PageVec, rotation: number): string {
  const fill = escapeAttr(object.fill);
  const stroke = escapeAttr(object.strokeColor);
  const strokeWidth = fmt(object.strokeWidth);
  const pathAttrs = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"`;

  let shapes: string;
  if (object.tail && object.shape !== "thought") {
    shapes = `<path d="${balloonUnionPath(object.shape, object.size, object.tail)}" ${pathAttrs} />`;
  } else {
    shapes = `<path d="${balloonBodyPath(object.shape, object.size)}" ${pathAttrs} />`;
    if (object.tail) {
      shapes += balloonThoughtCircles(object.size, object.tail)
        .map(
          (circle) =>
            `<circle cx="${fmt(circle.cx)}" cy="${fmt(circle.cy)}" r="${fmt(circle.r)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />`
        )
        .join("");
    }
  }
  const deg = (rotation * 180) / Math.PI;
  const groupTransform = `translate(${fmt(anchor.x)} ${fmt(anchor.y)})${deg ? ` rotate(${fmt(deg)})` : ""}`;
  return `<g class="page-object-balloon-shape" transform="${groupTransform}">${shapes}</g>`;
}
