export const WEB_SAM_MASK_COUNT = 3;

export interface PostProcessedMasks {
  masks: Uint8Array[];
  scores: number[];
  selectedIndex: number;
  rawLogits: Float32Array;
}

/** Decoder logitsを出力解像度へ補間し、表示用alphaと再処理用logitsを同時に作る。 */
export function postProcessMasks(
  rawMasks: Float32Array,
  rawScores: Float32Array,
  maskWidth: number,
  maskHeight: number,
  outputWidth: number,
  outputHeight: number,
  threshold: number,
  smoothing: number
): PostProcessedMasks {
  const scores: number[] = [];
  const masks: Uint8Array[] = [];
  const totalPixelsPerMask = maskWidth * maskHeight;
  const outputPixels = outputWidth * outputHeight;
  const rawLogits = new Float32Array(WEB_SAM_MASK_COUNT * outputPixels);
  const maskScaleX = maskWidth / Math.max(outputWidth, outputHeight);
  const maskScaleY = maskHeight / Math.max(outputWidth, outputHeight);
  const scratchA = new Uint8Array(outputPixels);
  const scratchB = new Uint8Array(outputPixels);
  let selectedIndex = 0;
  let bestScore = -Infinity;

  for (let index = 0; index < WEB_SAM_MASK_COUNT; index += 1) {
    const score = Number(rawScores[index] ?? 0);
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      selectedIndex = index;
    }
  }

  for (let maskIndex = 0; maskIndex < WEB_SAM_MASK_COUNT; maskIndex += 1) {
    const maskOffset = maskIndex * totalPixelsPerMask;
    const logitOffset = maskIndex * outputPixels;
    const alpha = new Uint8Array(outputPixels);
    for (let y = 0; y < outputHeight; y += 1) {
      const outputRow = y * outputWidth;
      const sampleY = y * maskScaleY;
      for (let x = 0; x < outputWidth; x += 1) {
        const outputIndex = outputRow + x;
        const logit = bilinearSample(rawMasks, maskOffset, maskWidth, maskHeight, x * maskScaleX, sampleY);
        rawLogits[logitOffset + outputIndex] = logit;
        alpha[outputIndex] = logit > threshold ? 255 : 0;
      }
    }
    smoothBinaryMask(alpha, outputWidth, outputHeight, smoothing, scratchA, scratchB);
    masks.push(alpha);
  }

  return { masks, scores, selectedIndex, rawLogits };
}

/** スライダー再処理では選択候補だけを閾値化・平滑化する。 */
export function reprocessMask(
  rawLogits: Float32Array,
  outputWidth: number,
  outputHeight: number,
  maskIndex: number,
  threshold: number,
  smoothing: number
): Uint8Array {
  if (!Number.isInteger(maskIndex) || maskIndex < 0 || maskIndex >= WEB_SAM_MASK_COUNT) {
    throw new Error(`Invalid WebSAM mask index: ${maskIndex}`);
  }
  const outputPixels = outputWidth * outputHeight;
  if (rawLogits.length !== WEB_SAM_MASK_COUNT * outputPixels) {
    throw new Error("Cached WebSAM logits do not match the requested output size.");
  }
  const alpha = new Uint8Array(outputPixels);
  const logitOffset = maskIndex * outputPixels;
  for (let pixel = 0; pixel < outputPixels; pixel += 1) {
    alpha[pixel] = rawLogits[logitOffset + pixel]! > threshold ? 255 : 0;
  }
  smoothBinaryMask(alpha, outputWidth, outputHeight, smoothing);
  return alpha;
}

/** alpha自身を最終出力に使い、2本のscratchを全passで再利用する。 */
export function smoothBinaryMask(
  alpha: Uint8Array,
  width: number,
  height: number,
  smoothing: number,
  scratchA = new Uint8Array(alpha.length),
  scratchB = new Uint8Array(alpha.length)
): Uint8Array {
  const passes = Math.max(0, Math.min(4, Math.round(smoothing)));
  if (passes <= 0) {
    return alpha;
  }
  if (alpha.length !== width * height || scratchA.length !== alpha.length || scratchB.length !== alpha.length) {
    throw new Error("WebSAM mask buffers do not match the requested dimensions.");
  }
  for (let pass = 0; pass < passes; pass += 1) {
    erodeInto(alpha, scratchA, width, height);
    dilateInto(scratchA, scratchB, width, height);
    dilateInto(scratchB, scratchA, width, height);
    erodeInto(scratchA, alpha, width, height);
  }
  return alpha;
}

function erodeInto(source: Uint8Array, destination: Uint8Array, width: number, height: number) {
  destination.fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const rowAbove = (y === 0 ? 0 : y - 1) * width;
    const rowBelow = (y === height - 1 ? y : y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const left = row + (x === 0 ? 0 : x - 1);
      const right = row + (x === width - 1 ? x : x + 1);
      if (
        source[index]! > 128 &&
        source[left]! > 128 &&
        source[right]! > 128 &&
        source[rowAbove + x]! > 128 &&
        source[rowBelow + x]! > 128
      ) {
        destination[index] = 255;
      }
    }
  }
}

function dilateInto(source: Uint8Array, destination: Uint8Array, width: number, height: number) {
  destination.fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const rowAbove = (y === 0 ? 0 : y - 1) * width;
    const rowBelow = (y === height - 1 ? y : y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const left = row + (x === 0 ? 0 : x - 1);
      const right = row + (x === width - 1 ? x : x + 1);
      if (
        source[index]! > 128 ||
        source[left]! > 128 ||
        source[right]! > 128 ||
        source[rowAbove + x]! > 128 ||
        source[rowBelow + x]! > 128
      ) {
        destination[index] = 255;
      }
    }
  }
}

function bilinearSample(data: Float32Array, offset: number, width: number, height: number, x: number, y: number) {
  const x0 = Math.max(0, Math.min(Math.floor(x), width - 1));
  const y0 = Math.max(0, Math.min(Math.floor(y), height - 1));
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = data[offset + y0 * width + x0] ?? 0;
  const v10 = data[offset + y0 * width + x1] ?? 0;
  const v01 = data[offset + y1 * width + x0] ?? 0;
  const v11 = data[offset + y1 * width + x1] ?? 0;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}
