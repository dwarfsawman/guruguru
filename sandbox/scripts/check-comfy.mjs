const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8288").replace(/\/$/, "");

async function json(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const stats = await json("/system_stats");
const devices = stats.devices ?? stats.system?.devices ?? [];
if (!devices.some((device) => /cuda/i.test(String(device.type ?? device.name ?? "")))) {
  throw new Error(`CUDA device not reported: ${JSON.stringify(devices)}`);
}

const objectInfo = await json("/object_info");
const pulidNodes = Object.keys(objectInfo).filter((name) => /pulid/i.test(name));
if (pulidNodes.length === 0) throw new Error("PuLID custom nodes are not registered");
const animaLlliteNode = Boolean(objectInfo.AnimaLLLiteApply);

const filenames = [];
for (const node of Object.values(objectInfo)) {
  const required = node?.input?.required ?? {};
  for (const value of Object.values(required)) {
    if (Array.isArray(value?.[0])) filenames.push(...value[0].map(String));
  }
}
const modelPatterns = {
  diffusion: /(chroma|flux|anima).*\.(safetensors|gguf)$/i,
  textEncoder: /(t5|clip|qwen).*\.(safetensors|gguf|bin)$/i,
  vae: /(?:vae|ae).*\.(safetensors|pt|bin)$/i,
};
const recognition = Object.fromEntries(
  Object.entries(modelPatterns).map(([key, pattern]) => [key, filenames.some((name) => pattern.test(name))]),
);

const ok = animaLlliteNode && Object.values(recognition).every(Boolean);
console.log(JSON.stringify({
  ok,
  comfyui: baseUrl,
  devices,
  pulidNodes,
  animaLlliteNode,
  modelRecognition: recognition,
}, null, 2));

if (!ok) process.exitCode = 2;
