import { reprocessMask } from "../src/client/websam/maskPostprocess.ts";

const width = positiveIntegerArg("--width", 1024);
const height = positiveIntegerArg("--height", 1446);
const smoothing = integerArg("--smoothing", 4, 0, 4);
const samples = positiveIntegerArg("--samples", 7);
const pixelCount = width * height;
const logits = new Float32Array(pixelCount * 3);
for (let index = 0; index < logits.length; index += 1) {
  logits[index] = (index % 17) - 8;
}

reprocessMask(logits, width, height, 1, 0, smoothing);
const times = [];
for (let sample = 0; sample < samples; sample += 1) {
  const startedAt = performance.now();
  reprocessMask(logits, width, height, 1, 0, smoothing);
  times.push(performance.now() - startedAt);
}
times.sort((left, right) => left - right);
const medianMs = times[Math.floor(times.length / 2)];
console.log(JSON.stringify({
  width,
  height,
  smoothing,
  candidates: 1,
  samples,
  medianMs: Number(medianMs.toFixed(3)),
  minMs: Number(times[0].toFixed(3)),
  maxMs: Number(times.at(-1).toFixed(3)),
  wasmRecommended: medianMs > 50
}, null, 2));

function positiveIntegerArg(name, fallback) {
  return integerArg(name, fallback, 1, Number.MAX_SAFE_INTEGER);
}

function integerArg(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
