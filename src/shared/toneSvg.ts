/**
 * スクリーントーン(ToneObject)の SVG フラグメント生成(Docs/Feature-ScreenTones.md)。純ロジックのみ
 * (DOM・db 非依存) -- クライアントのステージ描画(`pagePanelLightboxView.ts`)とサーバの書き出し
 * (`openRasterExport.ts` → PNG/JPEG/PPTX/ORA 全経路)の両方がここの `renderToneSvg` を呼ぶことで、
 * プレビューと書き出しの見た目を一致させる(`textSvg.ts`/`balloonShape.ts` と同じ「共有 SVG フラグメント
 * 生成」方針)。API 形も `renderBalloonSvg` に合わせてある(anchor+rotation を受け取り
 * `<g transform="translate(...) rotate(...)">` で包む)。
 *
 * 座標系は `pageObjects.ts` と同じ page-width 単位・**オブジェクト中心=原点**(回転前)。
 *
 * 種別ごとの描画方式:
 * - halftone/lines: `<pattern patternUnits="userSpaceOnUse">` + `patternTransform="rotate(...)"` を
 *   領域 rect に敷く(無限タイルなので回転の基準点はどこでもよい)。
 * - gradient: halftone と同じ固定径ドットパターンに、`<linearGradient>` を使った `<mask>` を重ねて
 *   angle 方向の濃度遷移を近似する(v1: ドット径固定+マスク減衰。仕様書に明記の簡略化)。
 * - speed/focus/flash: 決定的 PRNG(mulberry32、seed 付き)で線・星形を生成する。stroke ではなく
 *   fill パス(先細りの三角形)にするのは、漫画的なシャープさと librsvg 互換のため(仕様書指定)。
 *   - speed: angle 方向に長い三角形を領域内へランダム配置(位置/長さ/太さに jitter)。
 *   - focus: params.center から外周へ向かう三角形群。tip(先端)は innerRadius 以上離れた位置に固定し
 *     (jitter は外側へ広げる方向にのみ効かせる)、中心付近に線が届かないことを保証する。
 *   - flash: 領域を color で塗り、中心に innerRadius 基準のジャギー多角形を白(#ffffff、非透過)で
 *     重ねて抜く。lineWidth は focus と同じ「外周側の基部太さ」の意味を転用し、棘の突出量に使う。
 * - 全種別共通: 領域(size)への `<clipPath>` で必ずクリップする(パターン/線が領域外へはみ出さないため)。
 *
 * **id 衝突禁止**: pattern/mask/gradient/clipPath の id は `object.id` を含めて一意化する(サーバは1つの
 * SVG に複数オブジェクトを並べるため必須。`panelClipId`/`image-object-clip-*` の前例踏襲)。
 */
import type { PageVec, ToneObject, ToneParams } from "./pageObjects";
import { TONE_COUNT_MAX, TONE_PITCH_MAX, TONE_PITCH_MIN } from "./pageObjects";

/** 数値の SVG 属性向け文字列化(`balloonShape.ts` と同じ絶対 6 桁丸め)。 */
function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "0";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** defs の id に使えない文字をサニタイズする(`panelClipId` と同じ規約)。 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** params の欠損に備えたフォールバック取得(正規化を経ない入力からの直接呼び出しへの防御)。 */
function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// --- 決定的 PRNG(mulberry32)。dialogueAutoLayout.ts と同一アルゴリズムをこのモジュール内に独立実装する
//     (仕様書の指定: 依存を増やさず「同じオブジェクト→同じSVG」の決定性をこのモジュール単体で保証する)。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ToneSvgInput = Pick<ToneObject, "id" | "toneType" | "size" | "color" | "opacity" | "seed" | "params">;

/**
 * トーン1件の SVG フラグメント(`renderBalloonSvg` と同じ API 形: anchor+rotation で包む)。
 * `pagePanelLightboxView.ts`(プレビュー)と `openRasterExport.ts`(書き出し)の両方がこれを呼ぶ。
 */
export function renderToneSvg(object: ToneSvgInput, anchor: PageVec, rotation: number): string {
  const uid = sanitizeId(object.id);
  const hx = Math.max(1e-6, object.size.x / 2);
  const hy = Math.max(1e-6, object.size.y / 2);
  const regionClipId = `tone-region-${uid}`;
  const regionRectAttrs = `x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}"`;
  const body = renderToneBody(object, uid, hx, hy);
  const opacity = clamp(num(object.opacity, 1), 0, 1);
  const deg = (rotation * 180) / Math.PI;
  const groupTransform = `translate(${fmt(anchor.x)} ${fmt(anchor.y)})${deg ? ` rotate(${fmt(deg)})` : ""}`;
  return `<g class="page-object-tone-shape" transform="${groupTransform}" opacity="${fmt(opacity)}"><defs><clipPath id="${regionClipId}"><rect ${regionRectAttrs} /></clipPath></defs><g clip-path="url(#${regionClipId})">${body}</g></g>`;
}

function renderToneBody(object: ToneSvgInput, uid: string, hx: number, hy: number): string {
  switch (object.toneType) {
    case "halftone":
      return renderHalftoneBody(object.params, object.color, uid, hx, hy);
    case "gradient":
      return renderGradientBody(object.params, object.color, uid, hx, hy);
    case "lines":
      return renderLinesBody(object.params, object.color, uid, hx, hy);
    case "speed":
      return renderSpeedBody(object.params, object.color, object.seed, hx, hy);
    case "focus":
      return renderFocusBody(object.params, object.color, object.seed, hx, hy);
    case "flash":
      return renderFlashBody(object.params, object.color, object.seed, hx, hy);
    default:
      return "";
  }
}

// --- halftone / lines / gradient(パターン系。決定的な幾何のみ、PRNG 不要) ---

function resolvedPitch(params: ToneParams): number {
  return clamp(num(params.pitch, 0.015), TONE_PITCH_MIN, TONE_PITCH_MAX);
}

/** halftone/gradient 共通のドットパターン `<pattern>` 断片(gradient はこれを固定径のまま流用する)。 */
function halftonePatternFragment(params: ToneParams, color: string, patternId: string): string {
  const pitch = resolvedPitch(params);
  const dotRatio = clamp(num(params.dotRatio, 0.45), 0, 1);
  const radius = Math.max(0, (dotRatio * pitch) / 2);
  const angle = num(params.angle, 45);
  return `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${fmt(pitch)}" height="${fmt(pitch)}" patternTransform="rotate(${fmt(angle)})"><circle cx="${fmt(pitch / 2)}" cy="${fmt(pitch / 2)}" r="${fmt(radius)}" fill="${escapeAttr(color)}" /></pattern>`;
}

function renderHalftoneBody(params: ToneParams, color: string, uid: string, hx: number, hy: number): string {
  const patternId = `tone-pattern-${uid}`;
  const pattern = halftonePatternFragment(params, color, patternId);
  const rect = `<rect x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}" fill="url(#${patternId})" />`;
  return `<defs>${pattern}</defs>${rect}`;
}

function renderLinesBody(params: ToneParams, color: string, uid: string, hx: number, hy: number): string {
  const pitch = resolvedPitch(params);
  const lineRatio = clamp(num(params.lineRatio, 0.35), 0, 1);
  const angle = num(params.angle, 0);
  const patternId = `tone-lines-${uid}`;
  const pattern = `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${fmt(pitch)}" height="${fmt(pitch)}" patternTransform="rotate(${fmt(angle)})"><rect x="0" y="0" width="${fmt(pitch)}" height="${fmt(pitch * lineRatio)}" fill="${escapeAttr(color)}" /></pattern>`;
  const rect = `<rect x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}" fill="url(#${patternId})" />`;
  return `<defs>${pattern}</defs>${rect}`;
}

/**
 * v1: ドット径固定(dotRatio 由来)の halftone パターンへ、`<linearGradient>` の `<mask>` で
 * angle 方向の濃度遷移を重ねる簡略実装(仕様書に明記の割り切り -- 本来の網点グラデはドット径自体が
 * 遷移するが、v1 はマスク減衰で近似する)。
 */
function renderGradientBody(params: ToneParams, color: string, uid: string, hx: number, hy: number): string {
  const patternId = `tone-pattern-${uid}`;
  const gradientId = `tone-gradient-${uid}`;
  const maskId = `tone-mask-${uid}`;
  const pattern = halftonePatternFragment(params, color, patternId);
  const startRatio = clamp(num(params.startRatio, 0.7), 0, 1);
  const endRatio = clamp(num(params.endRatio, 0.05), 0, 1);
  const angle = num(params.angle, 45);
  const gradient = `<linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="0" gradientTransform="rotate(${fmt(angle)} 0.5 0.5)"><stop offset="0" stop-color="#fff" stop-opacity="${fmt(startRatio)}" /><stop offset="1" stop-color="#fff" stop-opacity="${fmt(endRatio)}" /></linearGradient>`;
  const rectAttrs = `x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}"`;
  const mask = `<mask id="${maskId}"><rect ${rectAttrs} fill="url(#${gradientId})" /></mask>`;
  const rect = `<rect ${rectAttrs} fill="url(#${patternId})" mask="url(#${maskId})" />`;
  return `<defs>${pattern}${gradient}${mask}</defs>${rect}`;
}

// --- speed / focus / flash(seed 付き PRNG で線・星形を生成) ---

/** 先細り三角形1本分の fill パス(base の2点→tip の1点→閉パス)。stroke ではなく fill(仕様書指定)。 */
function taperTrianglePath(baseA: PageVec, baseB: PageVec, tip: PageVec): string {
  return `M ${fmt(baseA.x)} ${fmt(baseA.y)} L ${fmt(tip.x)} ${fmt(tip.y)} L ${fmt(baseB.x)} ${fmt(baseB.y)} Z`;
}

function renderSpeedBody(params: ToneParams, color: string, seed: number, hx: number, hy: number): string {
  const angleDeg = num(params.angle, 45);
  const count = Math.round(clamp(num(params.count, 90), 1, TONE_COUNT_MAX));
  const lengthRatio = clamp(num(params.length, 0.7), 0, 1);
  const lineWidth = Math.max(0, num(params.lineWidth, 0.004));
  const jitter = clamp(num(params.jitter, 0.5), 0, 1);
  const rad = (angleDeg * Math.PI) / 180;
  const dir: PageVec = { x: Math.cos(rad), y: Math.sin(rad) };
  const perp: PageVec = { x: -dir.y, y: dir.x };
  // 領域(size)を dir/perp 軸へ投影した半幅(角度によらず領域を覆えるだけの散らばり範囲)。
  const alongHalf = Math.abs(dir.x) * hx + Math.abs(dir.y) * hy;
  const perpHalf = Math.abs(perp.x) * hx + Math.abs(perp.y) * hy;
  const baseLen = Math.max(0, lengthRatio * (alongHalf * 2));
  const random = mulberry32(seed);
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const alongOffset = (random() * 2 - 1) * alongHalf * 1.1;
    const perpOffset = (random() * 2 - 1) * perpHalf * 1.1;
    const lenJitter = Math.max(0, 1 + (random() * 2 - 1) * jitter);
    const widthJitter = Math.max(0, 1 + (random() * 2 - 1) * jitter);
    const len = Math.max(1e-4, baseLen * lenJitter);
    const halfWidth = Math.max(1e-4, (lineWidth / 2) * widthJitter);
    const centerX = dir.x * alongOffset + perp.x * perpOffset;
    const centerY = dir.y * alongOffset + perp.y * perpOffset;
    const tail = { x: centerX - dir.x * (len / 2), y: centerY - dir.y * (len / 2) };
    const head = { x: centerX + dir.x * (len / 2), y: centerY + dir.y * (len / 2) };
    const baseA = { x: tail.x + perp.x * halfWidth, y: tail.y + perp.y * halfWidth };
    const baseB = { x: tail.x - perp.x * halfWidth, y: tail.y - perp.y * halfWidth };
    paths.push(taperTrianglePath(baseA, baseB, head));
  }
  return `<path d="${paths.join(" ")}" fill="${escapeAttr(color)}" />`;
}

function resolvedCenter(params: ToneParams): PageVec {
  const center = params.center;
  return center && Number.isFinite(center.x) && Number.isFinite(center.y) ? center : { x: 0, y: 0 };
}

/** center から領域の隅までの最大距離+余白(focus の外周側の描画開始点が確実に領域を覆うための半径)。 */
function outerRadiusFor(center: PageVec, hx: number, hy: number): number {
  const corners: PageVec[] = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy }
  ];
  const maxDist = corners.reduce((max, corner) => Math.max(max, Math.hypot(corner.x - center.x, corner.y - center.y)), 0);
  return maxDist * 1.05 + 1e-3;
}

function renderFocusBody(params: ToneParams, color: string, seed: number, hx: number, hy: number): string {
  const center = resolvedCenter(params);
  const innerRadius = Math.max(0, num(params.innerRadius, 0.12));
  const count = Math.round(clamp(num(params.count, 72), 1, TONE_COUNT_MAX));
  const lineWidth = Math.max(0, num(params.lineWidth, 0.012));
  const jitter = clamp(num(params.jitter, 0.5), 0, 1);
  const outerRadius = outerRadiusFor(center, hx, hy);
  const random = mulberry32(seed);
  const angleStep = (Math.PI * 2) / count;
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 隣接線と交差しない範囲(半間隔以内)だけ角度を揺らす。
    const theta = i * angleStep + (random() * 2 - 1) * jitter * (angleStep / 2);
    const dir: PageVec = { x: Math.cos(theta), y: Math.sin(theta) };
    const perp: PageVec = { x: -dir.y, y: dir.x };
    // tip は innerRadius 以上(jitter は外側へ広げる方向にのみ効かせる) -- 中心付近に線が届かないことを保証する。
    const rInner = innerRadius * (1 + random() * jitter * 0.6);
    const widthJitter = Math.max(0, 1 + (random() * 2 - 1) * jitter);
    const halfWidth = Math.max(1e-4, (lineWidth / 2) * widthJitter);
    const base = { x: center.x + dir.x * outerRadius, y: center.y + dir.y * outerRadius };
    const tip = { x: center.x + dir.x * rInner, y: center.y + dir.y * rInner };
    const baseA = { x: base.x + perp.x * halfWidth, y: base.y + perp.y * halfWidth };
    const baseB = { x: base.x - perp.x * halfWidth, y: base.y - perp.y * halfWidth };
    paths.push(taperTrianglePath(baseA, baseB, tip));
  }
  return `<path d="${paths.join(" ")}" fill="${escapeAttr(color)}" />`;
}

/**
 * 領域を color で塗り、中心にジャギー多角形の白(#ffffff、非透過)抜きを重ねる。lineWidth は
 * focus と params 形状を揃えるため保持しているフィールドだが、flash では「外周側の基部太さ」ではなく
 * 棘の突出量(ジャギーの鋭さ)に転用する -- 死んだフィールドにしない設計判断(仕様書は「focus と同じ」
 * としか書いておらず、視覚的な使い道は実装側の裁量)。
 */
function renderFlashBody(params: ToneParams, color: string, seed: number, hx: number, hy: number): string {
  const center = resolvedCenter(params);
  const innerRadius = Math.max(0, num(params.innerRadius, 0.18));
  const count = Math.round(clamp(num(params.count, 72), 3, TONE_COUNT_MAX));
  const lineWidth = Math.max(0, num(params.lineWidth, 0.012));
  const jitter = clamp(num(params.jitter, 0.5), 0, 1);
  const random = mulberry32(seed);
  const points: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2;
    const spike = lineWidth * random() * 2;
    const r = Math.max(0, innerRadius * (1 + (random() * 2 - 1) * jitter * 0.6) + spike);
    points.push(`${fmt(center.x + Math.cos(theta) * r)},${fmt(center.y + Math.sin(theta) * r)}`);
  }
  const fillRect = `<rect x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}" fill="${escapeAttr(color)}" />`;
  // 「白抜き」は透過ではなく不透明白 #ffffff で塗る(仕様書指定 -- 下のレイヤーを透かして見せない)。
  const cutout = `<polygon points="${points.join(" ")}" fill="#ffffff" />`;
  return `${fillRect}${cutout}`;
}
