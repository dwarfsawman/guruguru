/**
 * コマぶち抜き立ち絵の切り抜き(Docs/Reference-MangaCompositions.md)。
 *
 * 「無地(白など)の背景で生成した全身立ち絵」を前提に、
 *   1. 画像の縁 2px リングから背景色(中央値)を推定し、
 *   2. 縁から到達できる背景色近似ピクセルをフラッドフィルで透明化し(内側の白服などは残る)、
 *   3. 前景の周囲へ白フチ(chamfer 距離変換)を焼き込み、
 *   4. 透明余白をトリムした RGBA PNG を返す。
 *
 * 依存は sharp のみ(モデル不使用・決定的)。背景が無地でない画像(前景率が異常)は null を
 * 返し、呼び出し側は通常のコマ割当へフォールバックする。候補は人間 review を通るため、
 * ここでの品質判定は「明らかに切り抜きが成立しない画像を弾く」ことだけを狙う。
 */
import sharp from "sharp";

export interface FigureCutoutOptions {
  /** 背景色とみなす RGB ユークリッド距離のしきい値(0〜441)。 */
  tolerance?: number;
  /** 白フチの太さ(短辺に対する比)。 */
  outlineRatio?: number;
  /** 処理する最大長辺(px)。これより大きい入力は縮小してから処理する。 */
  maxLongEdge?: number;
}

export interface FigureCutoutResult {
  png: Buffer;
  width: number;
  height: number;
  /** 縮小後キャンバスに対する前景率(0〜1)。ログ・テスト用。 */
  foregroundRatio: number;
}

/** 数値配列の中央値(空なら 0)。 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export async function cutoutFigure(source: string | Buffer, options: FigureCutoutOptions = {}): Promise<FigureCutoutResult | null> {
  const tolerance = Math.max(4, Math.min(180, options.tolerance ?? 34));
  const maxLongEdge = Math.max(256, Math.min(4096, options.maxLongEdge ?? 1792));

  const base = sharp(source).rotate();
  const metadata = await base.metadata();
  if (!metadata.width || !metadata.height) return null;
  const needsResize = Math.max(metadata.width, metadata.height) > maxLongEdge;
  const pipeline = needsResize ? base.resize({ width: maxLongEdge, height: maxLongEdge, fit: "inside" }) : base;
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width < 16 || height < 16 || channels !== 4) return null;

  // 1) 縁 2px リングの中央値から背景色を推定する(白背景プロンプトが前提だが、モデルが
  //    わずかに色被りさせても追従できるよう、固定の「白」ではなく実測値を使う)。
  const ringR: number[] = [];
  const ringG: number[] = [];
  const ringB: number[] = [];
  const pushRing = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    ringR.push(data[index]!);
    ringG.push(data[index + 1]!);
    ringB.push(data[index + 2]!);
  };
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, 1, height - 2, height - 1]) pushRing(x, y);
  }
  for (let y = 2; y < height - 2; y += 1) {
    for (const x of [0, 1, width - 2, width - 1]) pushRing(x, y);
  }
  const bgR = median(ringR);
  const bgG = median(ringG);
  const bgB = median(ringB);

  const toleranceSq = tolerance * tolerance;
  const isBackgroundColor = (index: number): boolean => {
    const dr = data[index]! - bgR;
    const dg = data[index + 1]! - bgG;
    const db = data[index + 2]! - bgB;
    return dr * dr + dg * dg + db * db <= toleranceSq;
  };

  // 2) 縁から到達可能な背景をフラッドフィル(4近傍)。スタックは Int32Array で確保する。
  const total = width * height;
  const background = new Uint8Array(total);
  const stack = new Int32Array(total);
  let stackSize = 0;
  const seed = (pixel: number) => {
    if (!background[pixel] && isBackgroundColor(pixel * 4)) {
      background[pixel] = 1;
      stack[stackSize] = pixel;
      stackSize += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stackSize > 0) {
    stackSize -= 1;
    const pixel = stack[stackSize]!;
    const x = pixel % width;
    const y = (pixel / width) | 0;
    if (x > 0) seed(pixel - 1);
    if (x < width - 1) seed(pixel + 1);
    if (y > 0) seed(pixel - width);
    if (y < height - 1) seed(pixel + width);
  }

  let backgroundCount = 0;
  for (let pixel = 0; pixel < total; pixel += 1) backgroundCount += background[pixel]!;
  const foregroundRatio = (total - backgroundCount) / total;
  // 前景がほぼ無い/背景が十分消えない場合は切り抜き不成立。白背景の全身立ち絵は前景が
  // おおむね 2〜6 割に収まるため、0.72 超は「無地背景ではない」(グラデ・シーン背景)とみなす。
  if (foregroundRatio < 0.04 || foregroundRatio > 0.72) return null;

  // 3) 前景からの chamfer 距離(4近傍、2パス)。白フチ幅ぶんの背景ピクセルを白で塗る。
  const outlinePx = Math.max(2, Math.min(24, Math.round(Math.min(width, height) * (options.outlineRatio ?? 0.018))));
  const INF = 1 << 29;
  const distance = new Int32Array(total);
  for (let pixel = 0; pixel < total; pixel += 1) distance[pixel] = background[pixel] ? INF : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      let best = distance[pixel]!;
      if (x > 0) best = Math.min(best, distance[pixel - 1]! + 1);
      if (y > 0) best = Math.min(best, distance[pixel - width]! + 1);
      distance[pixel] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      let best = distance[pixel]!;
      if (x < width - 1) best = Math.min(best, distance[pixel + 1]! + 1);
      if (y < height - 1) best = Math.min(best, distance[pixel + width]! + 1);
      distance[pixel] = best;
    }
  }

  // 4) 出力 RGBA を組む: 前景=元色、白フチ帯=白(最外周 1px は半透明でなじませる)、他=透明。
  const output = Buffer.alloc(total * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const src = pixel * 4;
    const dst = pixel * 4;
    let alpha = 0;
    if (!background[pixel]) {
      output[dst] = data[src]!;
      output[dst + 1] = data[src + 1]!;
      output[dst + 2] = data[src + 2]!;
      alpha = 255;
    } else if (distance[pixel]! <= outlinePx) {
      output[dst] = 255;
      output[dst + 1] = 255;
      output[dst + 2] = 255;
      alpha = distance[pixel]! === outlinePx ? 140 : 255;
    }
    output[dst + 3] = alpha;
    if (alpha > 0) {
      const x = pixel % width;
      const y = (pixel / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const png = await sharp(output, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();
  return { png, width: cropWidth, height: cropHeight, foregroundRatio };
}
