import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { patchUnifiedSwitchWorkflow } from "../../src/server/workflowUnifiedSwitch.ts";

const ADAPTER = "anima-incontext-character.safetensors";
const REQUIRED_NODES = ["AnimaRefEncode", "AnimaRefLatentBatch", "AnimaInContextApply"];
const REFERENCE_SEED_BASE = 731_000;
const TARGET_SEED_BASE = 842_000;
const MODES = ["none", "face", "full_body", "face_full_body"];
const DEFAULT_OUTPUT_ROOT = resolve(process.env.TEMP ?? process.env.TMP ?? "C:/Temp", "guruguru-reference-benchmark");
const REPOSITORY_ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));

const CHARACTERS = [
  {
    id: "silver-scout",
    appearance: "adult woman, chin-length silver bob hair, teal eyes, black horn-shaped hairpin above her left temple, navy field coat, vivid red scarf, black gloves"
  },
  {
    id: "auburn-courier",
    appearance: "young adult man, short auburn undercut hair, green eyes, round black glasses, mustard yellow jacket, dark green messenger bag, brown boots"
  },
  {
    id: "violet-guard",
    appearance: "adult woman, long dark purple braided hair, golden eyes, crescent moon earrings, white combat suit with cobalt blue panels, bright orange utility belt"
  }
];

const SHOTS = [
  { id: "face_closeup", width: 768, height: 768, direction: "face close-up portrait, looking over shoulder, rainy neon street at night" },
  { id: "waist_up", width: 640, height: 768, direction: "waist-up three-quarter view, holding a ceramic cup, warm cafe interior" },
  { id: "full_body", width: 576, height: 768, direction: "full body standing pose, one hand raised, sunlit train platform" },
  { id: "distant_action", width: 768, height: 512, direction: "distant wide shot, running across a windy grass field, dynamic side view" }
];

function parseArgs(argv) {
  const options = { baseUrl: "http://127.0.0.1:8288", output: DEFAULT_OUTPUT_ROOT, steps: 30, phase: "768", scores: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--url") options.baseUrl = value, i += 1;
    else if (key === "--output") options.output = resolve(value), i += 1;
    else if (key === "--steps") options.steps = Number(value), i += 1;
    else if (key === "--phase") options.phase = value, i += 1;
    else if (key === "--scores") options.scores = resolve(value), i += 1;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 100) throw new Error("--steps must be an integer from 1 to 100");
  if (!["768", "1024"].includes(options.phase)) throw new Error("--phase must be 768 or 1024");
  return options;
}

function sandboxBaseUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) || parsed.port !== "8288") {
    throw new Error("This benchmark only accepts isolated ComfyUI at loopback port 8288");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("ComfyUI URL must contain only scheme, loopback host, and port 8288");
  }
  return parsed.origin;
}

function assertExternalOutput(output) {
  const rel = relative(REPOSITORY_ROOT, output);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Benchmark output must be outside the repository");
  }
}

const options = parseArgs(process.argv.slice(2));
const baseUrl = sandboxBaseUrl(options.baseUrl);
assertExternalOutput(options.output);
await mkdir(options.output, { recursive: true });

const workflow = JSON.parse(await readFile(new URL("../../Docs/ReferenceFlows/Reference-AnimaUnifiedSwitchWorkflow.json", import.meta.url), "utf8"));

async function request(path, init, timeout = 30_000) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function upload(path, uploadName) {
  const bytes = await readFile(path);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), uploadName);
  form.append("type", "input");
  form.append("overwrite", "true");
  const uploaded = await request("/upload/image", { method: "POST", body: form });
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function nodeInputChoices(objectInfo, classType, inputName) {
  const input = objectInfo?.[classType]?.input;
  const schema = input?.required?.[inputName] ?? input?.optional?.[inputName];
  return Array.isArray(schema?.[0]) ? schema[0].map(String) : [];
}

async function systemVramUsed() {
  const stats = await request("/system_stats", undefined, 10_000);
  const device = stats.devices?.[0];
  if (!device) return null;
  return Number(device.vram_total) - Number(device.vram_free);
}

async function queueAndWait(prompt, label) {
  const startedAt = performance.now();
  let peakVramBytes = await systemVramUsed();
  const queued = await request("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, client_id: `guruguru-reference-benchmark-${randomUUID()}` })
  });
  if (!queued.prompt_id) throw new Error(`${label}: ComfyUI did not return prompt_id`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const [history, used] = await Promise.all([
      request(`/history/${queued.prompt_id}`, undefined, 10_000),
      systemVramUsed()
    ]);
    if (used !== null) peakVramBytes = Math.max(peakVramBytes ?? 0, used);
    const entry = history[queued.prompt_id];
    if (entry) {
      const error = entry.status?.messages?.find((message) => message?.[0] === "execution_error");
      if (error) throw new Error(`${label}: ${JSON.stringify(error[1])}`);
      const images = Object.values(entry.outputs ?? {}).flatMap((output) => output?.images ?? []);
      if (images.length > 0) {
        return { promptId: queued.prompt_id, image: images[0], elapsedMs: Math.round(performance.now() - startedAt), peakVramBytes };
      }
      if (entry.status?.completed) throw new Error(`${label}: completed without an image output`);
    }
    await Bun.sleep(500);
  }
  throw new Error(`${label}: timed out`);
}

async function fetchOutput(image, targetPath) {
  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
  const response = await fetch(`${baseUrl}/view?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`/view: HTTP ${response.status}`);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readManifest() {
  const path = join(options.output, "manifest.json");
  if (!await exists(path)) return { schemaVersion: 1, baseUrl, phase: options.phase, steps: options.steps, references: {}, runs: [] };
  return JSON.parse(await readFile(path, "utf8"));
}

async function saveManifest(manifest) {
  await writeFile(join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function baseRequest({ prompt, seed, width, height }) {
  return {
    templateId: "anima-reference-benchmark",
    prompt: `masterpiece, best quality, score_7, safe, ${prompt}`,
    negativePrompt: "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, text, watermark, extra people",
    seed,
    seedMode: "fixed",
    batchSize: 1,
    steps: options.steps,
    cfg: 4,
    sampler: "er_sde",
    scheduler: "simple",
    denoise: 1,
    width,
    height,
    generationMode: "txt2img",
    parentAssetId: null,
    relationType: null,
    inpaint: null,
    controlnet: null
  };
}

const featureOff = { controlnet: false, pulid: false, animaInContext: false };
const dummyPath = join(options.output, "dummy.png");
if (!await exists(dummyPath)) {
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "#777777" } }).png().toFile(dummyPath);
}
const dummyName = await upload(dummyPath, "guruguru-reference-benchmark-dummy.png");
const objectInfo = await request("/object_info", undefined, 60_000);
const missingNodes = REQUIRED_NODES.filter((name) => !objectInfo[name]);
const hasAdapter = nodeInputChoices(objectInfo, "LoraLoaderModelOnly", "lora_name").includes(ADAPTER);
if (missingNodes.length || !hasAdapter) {
  throw new Error(`Anima In-Context is unavailable: missing nodes=${missingNodes.join(",") || "none"}, adapter=${hasAdapter}`);
}
const queue = await request("/queue");
if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("Isolated ComfyUI queue must be idle before the benchmark starts");

const manifest = await readManifest();
manifest.baseUrl = baseUrl;
manifest.phase = options.phase;
manifest.steps = options.steps;

async function generateReferences() {
  for (let index = 0; index < CHARACTERS.length; index += 1) {
    const character = CHARACTERS[index];
    const refDir = join(options.output, "references", character.id);
    const fullPath = join(refDir, "full_body.png");
    const facePath = join(refDir, "face.png");
    if (!await exists(fullPath)) {
      const requestValue = baseRequest({
        prompt: `1person, solo, ${character.appearance}, full body character reference, neutral front pose, plain light gray studio background`,
        seed: REFERENCE_SEED_BASE + index,
        width: 576,
        height: 768
      });
      const graph = patchUnifiedSwitchWorkflow(structuredClone(workflow), {
        projectId: "reference-benchmark",
        roundIndex: 1 + index,
        request: requestValue,
        dummyImageName: dummyName,
        featureAvailability: featureOff
      }, `guruguru/reference-benchmark/reference-${character.id}`);
      const result = await queueAndWait(graph, `reference:${character.id}`);
      await fetchOutput(result.image, fullPath);
      manifest.references[character.id] = { ...(manifest.references[character.id] ?? {}), generation: result };
      await saveManifest(manifest);
    }
    if (!await exists(facePath)) {
      const meta = await sharp(fullPath).metadata();
      const width = meta.width ?? 576;
      const height = meta.height ?? 768;
      const cropWidth = Math.max(128, Math.round(width * 0.56));
      const cropHeight = Math.max(128, Math.round(height * 0.42));
      await sharp(fullPath)
        .extract({ left: Math.round((width - cropWidth) / 2), top: 0, width: cropWidth, height: cropHeight })
        .resize(512, 512, { fit: "cover", position: "north" })
        .png()
        .toFile(facePath);
    }
    manifest.references[character.id] = { ...(manifest.references[character.id] ?? {}), facePath, fullBodyPath: fullPath, appearance: character.appearance };
    await saveManifest(manifest);
  }
}

function scaledShot(shot) {
  if (options.phase === "768") return shot;
  const scale = 1024 / Math.max(shot.width, shot.height);
  const multiple = (value) => Math.max(64, Math.round((value * scale) / 64) * 64);
  return { ...shot, width: multiple(shot.width), height: multiple(shot.height) };
}

async function selectedModes() {
  if (options.phase === "768") return new Map();
  if (!options.scores) throw new Error("--scores is required for the 1024 promotion phase");
  const scores = JSON.parse(await readFile(options.scores, "utf8"));
  return new Map(scores.winners.map((winner) => [`${winner.characterId}:${winner.shotId}`, winner.mode]));
}

await generateReferences();
const promotion = await selectedModes();
const uploads = new Map();
for (const character of CHARACTERS) {
  const ref = manifest.references[character.id];
  uploads.set(`${character.id}:face`, await upload(ref.facePath, `guruguru-reference-${character.id}-face.png`));
  uploads.set(`${character.id}:full_body`, await upload(ref.fullBodyPath, `guruguru-reference-${character.id}-full-body.png`));
}

let runIndex = 0;
for (let characterIndex = 0; characterIndex < CHARACTERS.length; characterIndex += 1) {
  const character = CHARACTERS[characterIndex];
  for (let shotIndex = 0; shotIndex < SHOTS.length; shotIndex += 1) {
    const shot = scaledShot(SHOTS[shotIndex]);
    const modes = options.phase === "768" ? MODES : [promotion.get(`${character.id}:${shot.id}`)].filter(Boolean);
    if (!modes.length) throw new Error(`No winning mode for ${character.id}/${shot.id}`);
    for (const mode of modes) {
      runIndex += 1;
      const key = `${options.phase}:${character.id}:${shot.id}:${mode}`;
      const targetPath = join(options.output, options.phase, character.id, shot.id, `${mode}.png`);
      if (manifest.runs.some((run) => run.key === key && run.completed) && await exists(targetPath)) continue;
      const requestValue = baseRequest({
        prompt: `1person, solo, ${character.appearance}, ${shot.direction}`,
        seed: TARGET_SEED_BASE + characterIndex * 100 + shotIndex,
        width: shot.width,
        height: shot.height
      });
      const context = {
        projectId: "reference-benchmark",
        roundIndex: 100 + runIndex,
        request: requestValue,
        dummyImageName: dummyName,
        featureAvailability: featureOff
      };
      if (mode !== "none") {
        const firstRole = mode === "full_body" ? "full_body" : "face";
        context.uploadedReferenceImageName = uploads.get(`${character.id}:${firstRole}`);
        if (mode === "face_full_body") context.uploadedFullBodyReferenceImageName = uploads.get(`${character.id}:full_body`);
        context.featureAvailability = { ...featureOff, animaInContext: true };
        context.request = {
          ...requestValue,
          reference: {
            imageDataUrl: null,
            imagePath: manifest.references[character.id][firstRole === "face" ? "facePath" : "fullBodyPath"],
            face: { enabled: false },
            animaInContext: { enabled: true }
          }
        };
      }
      const graph = patchUnifiedSwitchWorkflow(structuredClone(workflow), context, `guruguru/reference-benchmark/${options.phase}-${character.id}-${shot.id}-${mode}`);
      const result = await queueAndWait(graph, key);
      await fetchOutput(result.image, targetPath);
      const record = {
        key,
        phase: options.phase,
        characterId: character.id,
        shotId: shot.id,
        mode,
        seed: requestValue.seed,
        width: shot.width,
        height: shot.height,
        steps: options.steps,
        elapsedMs: result.elapsedMs,
        peakVramBytes: result.peakVramBytes,
        outputPath: targetPath,
        completed: true
      };
      manifest.runs = manifest.runs.filter((run) => run.key !== key);
      manifest.runs.push(record);
      await saveManifest(manifest);
      console.error(`[${runIndex}] ${key} ${(record.elapsedMs / 1000).toFixed(1)}s ${(record.peakVramBytes / 1024 ** 3).toFixed(2)}GiB`);
    }
  }
}

const scoreTemplatePath = join(options.output, "scores.template.json");
if (options.phase === "768" && !await exists(scoreTemplatePath)) {
  const rows = CHARACTERS.flatMap((character) => SHOTS.flatMap((shot) => MODES.map((mode) => ({
    characterId: character.id,
    shotId: shot.id,
    mode,
    face: null,
    hair: null,
    outfit: null,
    accessory: null,
    poseFollow: null,
    backgroundLeak: null,
    notes: ""
  }))));
  await writeFile(scoreTemplatePath, `${JSON.stringify({ scale: "1-5; backgroundLeak is 1=none, 5=severe", rows, winners: [] }, null, 2)}\n`);
}

async function createContactSheets() {
  if (options.phase !== "768") return;
  const labels = ["reference face", "reference full body", ...MODES];
  const tileWidth = 320;
  const tileHeight = 320;
  const labelHeight = 44;
  const sheetDir = join(options.output, "contact-sheets");
  await mkdir(sheetDir, { recursive: true });
  for (const character of CHARACTERS) {
    for (const shot of SHOTS) {
      const paths = [
        manifest.references[character.id].facePath,
        manifest.references[character.id].fullBodyPath,
        ...MODES.map((mode) => join(options.output, "768", character.id, shot.id, `${mode}.png`))
      ];
      if (!(await Promise.all(paths.map(exists))).every(Boolean)) continue;
      const composites = [];
      for (let index = 0; index < paths.length; index += 1) {
        const tile = await sharp(paths[index]).resize(tileWidth, tileHeight, { fit: "contain", background: "#15171b" }).png().toBuffer();
        composites.push({ input: tile, left: index * tileWidth, top: labelHeight });
        const safeLabel = labels[index].replace(/[<>&]/g, "");
        composites.push({
          input: Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#20242a"/><text x="16" y="29" fill="#f6f7f9" font-family="Arial" font-size="18">${safeLabel}</text></svg>`),
          left: index * tileWidth,
          top: 0
        });
      }
      await sharp({ create: { width: tileWidth * paths.length, height: tileHeight + labelHeight, channels: 3, background: "#15171b" } })
        .composite(composites)
        .jpeg({ quality: 90 })
        .toFile(join(sheetDir, `${character.id}--${shot.id}.jpg`));
    }
  }
}

await createContactSheets();

const completed = manifest.runs.filter((run) => run.phase === options.phase && run.completed);
const summary = {
  ok: true,
  phase: options.phase,
  output: options.output,
  completed: completed.length,
  maxPeakVramBytes: Math.max(...completed.map((run) => run.peakVramBytes ?? 0)),
  averageElapsedMs: Math.round(completed.reduce((sum, run) => sum + run.elapsedMs, 0) / Math.max(1, completed.length))
};
console.log(JSON.stringify(summary, null, 2));
