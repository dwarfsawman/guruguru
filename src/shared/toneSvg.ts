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
 *   領域 rect に敷く(無限タイルなので回転の基準点はどこでもよい)。lines は startRatio/endRatio が
 *   指定時のみ、縞と直交方向の `<mask>`(線形グラデ)を追加で重ねる(2026-07-14 追補、任意)。
 * - gradient: 2026-07-14 追補で v1(ドット径固定+マスク減衰の近似)から、角度方向に沿ってドット半径を
 *   start→end へ実際に補間する行生成(`<circle>` 群、PRNG 不要の決定的格子)へ強化した。領域面積/pitch²
 *   が要素数バジェット(約2万)を超える場合は実効 pitch を自動で粗くする(`effectiveGradientPitch`)。
 *   2026-07-15 追補: 遷移軸を optional な params.gradStart/gradEnd(ローカル座標の2点、ステージ上の
 *   ハンドルで編集)で指定できる。未指定は従来どおり angle 方向に領域全体で遷移(`effectiveGradientPoints`
 *   が2点へ正規化して吸収する)。2点の外側は最寄り端の濃度で平坦(t を 0..1 に clamp)。
 * - noise: seed 付き PRNG で生成した粒(`<circle>`)をタイル化した `<pattern>` に敷き詰め、パターンの
 *   自然なタイル繰り返しで領域全体を覆う(領域全面に個別要素を撒くと要素数が爆発するため)。startRatio/
 *   endRatio が指定時のみ角度方向の濃度 `<mask>` を追加する(lines と同じ仕組みを共有)。
 * - snow: seed 付き PRNG で angle 方向に伸びる楕円(`<ellipse>` + 個別 `rotate(...)`)を背面→前面の順に
 *   2層生成し、層ごとに `<filter><feGaussianBlur></filter>` でぼかす(背面=params.backColor、
 *   前面=object.color)。フィルタ region は `filterUnits="userSpaceOnUse"` で明示し、ぼかしがフィルタ
 *   region の既定マージンで切れないようにする。
 * - speed/focus/flash: 決定的 PRNG(mulberry32、seed 付き)で線・星形を生成する。stroke ではなく
 *   fill パス(先細りの三角形)にするのは、漫画的なシャープさと librsvg 互換のため(仕様書指定)。
 *   - speed: angle 方向に長い三角形を領域内へランダム配置(位置/長さ/太さに jitter)。
 *   - focus: params.center から外周へ向かう三角形群。tip(先端)は innerRadius 以上離れた位置に固定し
 *     (jitter は外側へ広げる方向にのみ効かせる)、中心付近に線が届かないことを保証する。外周側の
 *     基部(base)は既定で領域の外接円(outerRadiusFor)だが、params.outerRadius 指定時(2026-07-14
 *     追補、focus のみ)はその半径を使う。
 *   - flash: 領域を color で塗り、中心に「山(棘の先端)と谷(白核の縁)が交互に並ぶ星形」の白
 *     (#ffffff、非透過)を重ねて抜く(2026-07-15 刷新。v1 は頂点ごとに半径を独立乱択していたため
 *     輪郭が低周波にうねる「落書き」状だった)。lineWidth は flash では「棘の長さ」(基準突出量)。
 * - 全種別共通: 領域(size)への `<clipPath>` で必ずクリップする(パターン/線が領域外へはみ出さないため)。
 *
 * **id 衝突禁止**: pattern/mask/gradient/filter/clipPath の id は `object.id` を含めて一意化する
 * (サーバは1つの SVG に複数オブジェクトを並べるため必須。`panelClipId`/`image-object-clip-*` の前例踏襲)。
 */
import type { PageVec, ToneObject, ToneParams } from "./pageObjects";
import { TONE_COUNT_MAX, TONE_NOISE_GRAIN_MAX, TONE_NOISE_GRAIN_MIN, TONE_PITCH_MAX, TONE_PITCH_MIN } from "./pageObjects";

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
    case "noise":
      return renderNoiseBody(object.params, object.color, object.seed, uid, hx, hy);
    case "snow":
      return renderSnowBody(object.params, object.color, object.seed, uid, hx, hy);
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

/**
 * startRatio/endRatio のどちらかが指定されていれば「濃度グラデ有効」(2026-07-14 追補: lines/noise は
 * 任意グラデ。gradient(必須グラデ)はこの判定を使わず常に両方セットする)。
 */
function hasOptionalGradient(params: ToneParams): boolean {
  return typeof params.startRatio === "number" || typeof params.endRatio === "number";
}

/**
 * angle 方向の白(不透明度 startRatio→endRatio)線形グラデを領域全面に敷いた `<mask>` 断片。旧
 * renderGradientBody(v1)のマスク近似を lines/noise の「任意の濃度グラデ」向けに切り出したもの
 * (`hasOptionalGradient` で有効と判定した時だけ呼ぶこと)。id は種別ごとに prefix で分ける。
 */
function opacityMaskFragment(params: ToneParams, uid: string, prefix: string, hx: number, hy: number): { maskId: string; defs: string } {
  const gradientId = `tone-${prefix}-gradient-${uid}`;
  const maskId = `tone-${prefix}-mask-${uid}`;
  const startRatio = clamp(num(params.startRatio, 0.7), 0, 1);
  const endRatio = clamp(num(params.endRatio, 0.05), 0, 1);
  const angle = num(params.angle, 0);
  const gradient = `<linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="0" gradientTransform="rotate(${fmt(angle)} 0.5 0.5)"><stop offset="0" stop-color="#fff" stop-opacity="${fmt(startRatio)}" /><stop offset="1" stop-color="#fff" stop-opacity="${fmt(endRatio)}" /></linearGradient>`;
  const rectAttrs = `x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}"`;
  const mask = `<mask id="${maskId}"><rect ${rectAttrs} fill="url(#${gradientId})" /></mask>`;
  return { maskId, defs: `${gradient}${mask}` };
}

/**
 * lines は縞パターンに、startRatio/endRatio が指定時のみ濃度 `<mask>` を追加する(2026-07-14 追補)。
 * 縞の伸びる向きは angle(patternTransform で回す)、グラデの遷移方向はそれと直交=縞をまたぐ方向
 * なので、mask 側には angle+90° を渡す。
 */
function renderLinesBody(params: ToneParams, color: string, uid: string, hx: number, hy: number): string {
  const pitch = resolvedPitch(params);
  const lineRatio = clamp(num(params.lineRatio, 0.35), 0, 1);
  const angle = num(params.angle, 0);
  const patternId = `tone-lines-${uid}`;
  const pattern = `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${fmt(pitch)}" height="${fmt(pitch)}" patternTransform="rotate(${fmt(angle)})"><rect x="0" y="0" width="${fmt(pitch)}" height="${fmt(pitch * lineRatio)}" fill="${escapeAttr(color)}" /></pattern>`;
  const rectAttrs = `x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}"`;
  const rect = `<rect ${rectAttrs} fill="url(#${patternId})" />`;
  if (!hasOptionalGradient(params)) {
    return `<defs>${pattern}</defs>${rect}`;
  }
  const { maskId, defs } = opacityMaskFragment({ ...params, angle: angle + 90 }, uid, "lines", hx, hy);
  return `<defs>${pattern}${defs}</defs><rect ${rectAttrs} fill="url(#${patternId})" mask="url(#${maskId})" />`;
}

/** gradient(網グラデ)の要素数バジェット。領域面積/pitch² がこれを超えたら実効 pitch を粗くする(仕様書追補)。 */
const TONE_GRADIENT_DOT_BUDGET = 20000;

/** バジェットを超える場合、面積/pitch² がちょうどバジェットへ収まるよう pitch を大きくする(粗くする)。 */
function effectiveGradientPitch(pitch: number, hx: number, hy: number): number {
  if (pitch <= 0) {
    return TONE_PITCH_MIN;
  }
  const area = hx * 2 * hy * 2;
  const estimated = area / (pitch * pitch);
  if (estimated <= TONE_GRADIENT_DOT_BUDGET) {
    return pitch;
  }
  return pitch * Math.sqrt(estimated / TONE_GRADIENT_DOT_BUDGET);
}

/**
 * gradient の濃度遷移の始点/終点(ローカル座標)。params.gradStart/gradEnd が両方有効かつ十分離れて
 * いればそれを使い(2026-07-15 追補、ステージ上のハンドルで編集)、そうでなければ従来どおり
 * 「angle 方向に領域全体で遷移」に相当する2点(領域を angle 方向へ投影した両端)を返す。
 * クライアントのギズモ(ハンドル位置の描画・ドラッグ開始時の実効値 materialize)と描画
 * (`renderGradientBody`)の両方がこれを使うことで、ハンドル位置と見た目を常に一致させる。
 */
export function effectiveGradientPoints(params: ToneParams, hx: number, hy: number): { start: PageVec; end: PageVec } {
  const start = params.gradStart;
  const end = params.gradEnd;
  if (
    start &&
    end &&
    Number.isFinite(start.x) &&
    Number.isFinite(start.y) &&
    Number.isFinite(end.x) &&
    Number.isFinite(end.y) &&
    Math.hypot(end.x - start.x, end.y - start.y) > 1e-6
  ) {
    return { start: { ...start }, end: { ...end } };
  }
  const angleDeg = num(params.angle, 45);
  const rad = (angleDeg * Math.PI) / 180;
  const dir: PageVec = { x: Math.cos(rad), y: Math.sin(rad) };
  const alongHalf = Math.abs(dir.x) * hx + Math.abs(dir.y) * hy;
  return {
    start: { x: -dir.x * alongHalf, y: -dir.y * alongHalf },
    end: { x: dir.x * alongHalf, y: dir.y * alongHalf }
  };
}

/**
 * 2026-07-14 追補: v1(ドット径固定+マスク減衰の近似)をやめ、角度方向へ実際にドット半径を start→end
 * 補間する行生成にする。PRNG は使わない決定的な格子生成(仕様書「seed 不要」)。dotRatio は halftone との
 * 構造互換のため params には残すが、gradient の描画自体は startRatio/endRatio だけを半径比として使う。
 * 要素数は effectiveGradientPitch で約2万ドット以内に収める(仕様書指定の暴走防止)。
 * 2026-07-15 追補: 遷移軸は effectiveGradientPoints の2点(未指定は angle 由来)で決める。ドット格子の
 * 向きも遷移軸に合わせる(半径が変わる方向=格子の行方向、従来の angle 挙動と同じ関係)。
 */
function renderGradientBody(params: ToneParams, color: string, uid: string, hx: number, hy: number): string {
  const pitch = effectiveGradientPitch(resolvedPitch(params), hx, hy);
  const startRatio = clamp(num(params.startRatio, 0.7), 0, 1);
  const endRatio = clamp(num(params.endRatio, 0.05), 0, 1);
  const { start, end } = effectiveGradientPoints(params, hx, hy);
  const axisLen = Math.max(1e-6, Math.hypot(end.x - start.x, end.y - start.y));
  const dir: PageVec = { x: (end.x - start.x) / axisLen, y: (end.y - start.y) / axisLen };
  const perp: PageVec = { x: -dir.y, y: dir.x };
  // 領域を dir/perp 軸へ投影した半幅(角度によらず格子で領域全体を覆えるだけの範囲。speed/focus と同じ手法)。
  const alongHalf = Math.abs(dir.x) * hx + Math.abs(dir.y) * hy;
  const perpHalf = Math.abs(perp.x) * hx + Math.abs(perp.y) * hy;
  const iMax = Math.max(0, Math.ceil(alongHalf / pitch) + 1);
  const jMax = Math.max(0, Math.ceil(perpHalf / pitch) + 1);
  // 始点の dir 軸上の位置。t は「始点=0 → 終点=1」で、2点の外側は最寄り端の濃度で平坦(clamp)。
  const startAlong = start.x * dir.x + start.y * dir.y;
  const circles: string[] = [];
  for (let i = -iMax; i <= iMax; i += 1) {
    const along = i * pitch;
    const t = clamp((along - startAlong) / axisLen, 0, 1);
    const ratio = startRatio + (endRatio - startRatio) * t;
    const radius = Math.max(0, (ratio * pitch) / 2);
    if (radius <= 0) {
      continue;
    }
    for (let j = -jMax; j <= jMax; j += 1) {
      const cx = dir.x * along + perp.x * (j * pitch);
      const cy = dir.y * along + perp.y * (j * pitch);
      // 領域(rect)と交差しないドットは生成しない(要素数バジェットの実効性を確保する)。
      if (cx < -hx - radius || cx > hx + radius || cy < -hy - radius || cy > hy + radius) {
        continue;
      }
      circles.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}" fill="${escapeAttr(color)}" />`);
    }
  }
  return `<g>${circles.join("")}</g>`;
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
  // outerRadius 指定時(2026-07-14 追補、focus のみ)は線の外側の端をその半径にする。未指定/0以下は
  // 従来どおり領域の外接円(outerRadiusFor)まで。
  const outerRadius = typeof params.outerRadius === "number" && Number.isFinite(params.outerRadius) && params.outerRadius > 0
    ? params.outerRadius
    : outerRadiusFor(center, hx, hy);
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
 * ベタフラッシュ(2026-07-15 刷新): 領域を color で塗り、中心に「山(棘の先端)と谷(白核の縁)が
 * 交互に並ぶ星形」の白(#ffffff、非透過)を重ねて抜く。v1 は頂点ごとに半径を独立乱択していたため
 * 輪郭が低周波にうねる「落書き」状になっていた -- v2 は谷を innerRadius 近傍に揃えて白核の輪郭を
 * 円に近く保ち、山だけを外へ尖らせることで、ベタフラらしい鋭い放射状のギザギザにする。
 * lineWidth は focus と params 形状を揃えるため保持しているフィールドで、flash では「棘の長さ」
 * (山の基準突出量、page-width 単位)として使う -- 死んだフィールドにしない設計判断は v1 から継続。
 * jitter は棘の長さ(±85%)・山の角度(±1/4ステップ、隣の谷を跨がない=多角形が自己交差しない範囲)・
 * 谷のわずかな凹み(最大 -18%)に効く。
 */
function renderFlashBody(params: ToneParams, color: string, seed: number, hx: number, hy: number): string {
  const center = resolvedCenter(params);
  const innerRadius = Math.max(0, num(params.innerRadius, 0.18));
  const count = Math.round(clamp(num(params.count, 72), 3, TONE_COUNT_MAX));
  const spikeLength = Math.max(0, num(params.lineWidth, 0.08));
  const jitter = clamp(num(params.jitter, 0.5), 0, 1);
  const random = mulberry32(seed);
  const step = (Math.PI * 2) / count;
  const points: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 山(棘の先端)。角度ゆらぎは ±step/4 まで -- 谷(±step/2 の位置)を跨がないので頂点列の角度が
    // 単調増加のまま保たれ、星形が自己交差しない。
    const peakTheta = i * step + (random() * 2 - 1) * jitter * step * 0.25;
    // 棘の長さ: jitter で ±85% 変動させ、さらに低確率(jitter 比例)で 1.7 倍の長い棘を混ぜて単調さを崩す。
    let lengthFactor = Math.max(0.15, 1 + (random() * 2 - 1) * jitter * 0.85);
    if (random() < jitter * 0.2) {
      lengthFactor *= 1.7;
    }
    const peakR = innerRadius + spikeLength * lengthFactor;
    // 谷(白核の縁): innerRadius からわずかに内側へ(低振幅) -- 白核の輪郭は円に近く保つ。
    const valleyTheta = (i + 0.5) * step;
    const valleyR = innerRadius * (1 - random() * jitter * 0.18);
    points.push(
      `${fmt(center.x + Math.cos(peakTheta) * peakR)},${fmt(center.y + Math.sin(peakTheta) * peakR)}`,
      `${fmt(center.x + Math.cos(valleyTheta) * valleyR)},${fmt(center.y + Math.sin(valleyTheta) * valleyR)}`
    );
  }
  const fillRect = `<rect x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}" fill="${escapeAttr(color)}" />`;
  // 「白抜き」は透過ではなく不透明白 #ffffff で塗る(仕様書指定 -- 下のレイヤーを透かして見せない)。
  const cutout = `<polygon points="${points.join(" ")}" fill="#ffffff" />`;
  return `${fillRect}${cutout}`;
}

// --- noise(砂ノイズ。seed 付き PRNG の粒をタイル化 pattern で敷く。2026-07-14 追補) ---

/** 1タイル内に敷く粒の目安上限(density=1 の時の個数)。領域サイズに関わらず一定 -- パターンの自然な
 *  タイル繰り返しで面積をカバーするので、要素数(=SVGサイズ)は領域が大きくなっても増えない
 *  (v1 の割り切り: 非常に大きい領域では実効密度がやや薄く見えるトレードオフを許容する)。 */
const NOISE_TILE_GRAIN_COUNT = 300;

/** noise タイルの1辺(page-width 単位)。仕様書「領域の1/2〜1/4程度」を目安に短辺の1/3を基準値とし、
 *  粒(grain)が判別できる最低限のタイルサイズ(grain の12倍)を下限、領域そのものを上限にする。 */
function noiseTileSize(grain: number, hx: number, hy: number): number {
  const shortSide = Math.min(hx, hy) * 2;
  const longSide = Math.max(hx, hy) * 2;
  const base = shortSide / 3;
  return clamp(base, Math.max(grain * 12, 1e-4), Math.max(longSide, grain * 12, 1e-4));
}

/**
 * seed 付き乱数の粒(`<circle>`)をタイル化した `<pattern>` に敷き詰める。startRatio/endRatio が
 * 指定時のみ角度方向の濃度 `<mask>` を追加する(lines と同じ opacityMaskFragment を共有)。
 */
function renderNoiseBody(params: ToneParams, color: string, seed: number, uid: string, hx: number, hy: number): string {
  const density = clamp(num(params.density, 0.35), 0, 1);
  const grain = clamp(num(params.grain, 0.003), TONE_NOISE_GRAIN_MIN, TONE_NOISE_GRAIN_MAX);
  const radius = grain / 2;
  const tile = noiseTileSize(grain, hx, hy);
  const patternId = `tone-noise-${uid}`;
  const random = mulberry32(seed);
  const grainCount = Math.max(1, Math.round(NOISE_TILE_GRAIN_COUNT * density));
  const circles: string[] = [];
  for (let i = 0; i < grainCount; i += 1) {
    const cx = random() * tile;
    const cy = random() * tile;
    circles.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}" fill="${escapeAttr(color)}" />`);
  }
  const pattern = `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${fmt(tile)}" height="${fmt(tile)}">${circles.join("")}</pattern>`;
  const rectAttrs = `x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(hy * 2)}"`;
  const rect = `<rect ${rectAttrs} fill="url(#${patternId})" />`;
  if (!hasOptionalGradient(params)) {
    return `<defs>${pattern}</defs>${rect}`;
  }
  const { maskId, defs } = opacityMaskFragment(params, uid, "noise", hx, hy);
  return `<defs>${pattern}${defs}</defs><rect ${rectAttrs} fill="url(#${patternId})" mask="url(#${maskId})" />`;
}

// --- snow(雪・玉ボケ。seed 付き PRNG の楕円2層 + feGaussianBlur。2026-07-14 追補) ---

/** 楕円の短径/長径比。「angle 方向に伸びる」とのみ仕様書指定で具体比は実装裁量 -- 玉ボケらしい細長さにする。 */
const SNOW_ELLIPSE_ASPECT = 0.4;

/**
 * snow 1層分(前面 or 背面)。count 個の楕円を領域内へ散らし(位置のみ乱数、サイズ/角度は層内で均一)、
 * blurRatio>0 なら `<filter><feGaussianBlur></filter>` でぼかす。フィルタ region は
 * filterUnits="userSpaceOnUse" で明示し、既定マージン(objectBoundingBox 10%)によるぼかしの
 * 打ち切りを避ける。id は layer("front"/"back")+uid で一意化する。
 */
function snowLayerFragment(
  random: () => number,
  count: number,
  size: number,
  blurRatio: number,
  angleDeg: number,
  color: string,
  uid: string,
  layer: "front" | "back",
  hx: number,
  hy: number
): string {
  if (count <= 0) {
    return "";
  }
  const rx = Math.max(1e-5, size / 2);
  const ry = Math.max(1e-5, (size * SNOW_ELLIPSE_ASPECT) / 2);
  const ellipses: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const cx = (random() * 2 - 1) * hx;
    const cy = (random() * 2 - 1) * hy;
    ellipses.push(
      `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" transform="rotate(${fmt(angleDeg)} ${fmt(cx)} ${fmt(cy)})" fill="${escapeAttr(color)}" />`
    );
  }
  const body = ellipses.join("");
  const stdDeviation = Math.max(0, blurRatio * size);
  if (stdDeviation <= 0) {
    return `<g>${body}</g>`;
  }
  const filterId = `tone-snow-blur-${layer}-${uid}`;
  // フィルタ region は領域+ぼかし半径に余裕を持たせた絶対座標(userSpaceOnUse)。既定の
  // objectBoundingBox マージンだと、散らばった楕円群のバウンディングボックス基準になり縁が切れうるため。
  const margin = Math.max(hx, hy, size) * 3 + stdDeviation * 4;
  const filter = `<filter id="${filterId}" filterUnits="userSpaceOnUse" x="${fmt(-margin)}" y="${fmt(-margin)}" width="${fmt(margin * 2)}" height="${fmt(margin * 2)}"><feGaussianBlur stdDeviation="${fmt(stdDeviation)}" /></filter>`;
  return `<defs>${filter}</defs><g filter="url(#${filterId})">${body}</g>`;
}

/**
 * count(合計、≤400)を frontRatio で前面/背面に分け、背面→前面の順で重ねる(奥から手前へ、玉ボケの
 * 一般的な構図)。前面色=object.color、背面色=params.backColor(仕様書指定)。
 */
function renderSnowBody(params: ToneParams, color: string, seed: number, uid: string, hx: number, hy: number): string {
  const count = Math.round(clamp(num(params.count, 120), 1, TONE_COUNT_MAX));
  const frontRatio = clamp(num(params.frontRatio, 0.4), 0, 1);
  const frontCount = Math.round(count * frontRatio);
  const backCount = Math.max(0, count - frontCount);
  const frontSize = Math.max(1e-4, num(params.frontSize, 0.05));
  const backSize = Math.max(1e-4, num(params.backSize, 0.03));
  const frontBlurRatio = Math.max(0, num(params.frontBlur, 0.5));
  const backBlurRatio = Math.max(0, num(params.backBlur, 0.3));
  const angleDeg = num(params.angle, 115);
  const backColor = typeof params.backColor === "string" && params.backColor ? params.backColor : "#aaaaaa";
  const random = mulberry32(seed);
  const backLayer = snowLayerFragment(random, backCount, backSize, backBlurRatio, angleDeg, backColor, uid, "back", hx, hy);
  const frontLayer = snowLayerFragment(random, frontCount, frontSize, frontBlurRatio, angleDeg, color, uid, "front", hx, hy);
  return `${backLayer}${frontLayer}`;
}
