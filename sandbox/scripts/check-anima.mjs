import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { patchUnifiedSwitchWorkflow } from "../../src/server/workflowUnifiedSwitch.ts";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8288").replace(/\/$/, "");
const workflow = JSON.parse(
  await readFile(new URL("../../Docs/ReferenceFlows/Reference-AnimaUnifiedSwitchWorkflow.json", import.meta.url), "utf8")
);

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function upload(name, bytes) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), name);
  form.append("type", "input");
  form.append("overwrite", "true");
  const uploaded = await request("/upload/image", { method: "POST", body: form });
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

async function queueAndWait(prompt, label) {
  const queued = await request("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, client_id: `guruguru-anima-check-${randomUUID()}` })
  });
  if (!queued.prompt_id) throw new Error(`${label}: ComfyUI did not return prompt_id`);

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const history = await request(`/history/${queued.prompt_id}`);
    const entry = history[queued.prompt_id];
    if (entry) {
      const error = entry.status?.messages?.find((message) => message?.[0] === "execution_error");
      if (error) throw new Error(`${label}: ${JSON.stringify(error[1])}`);
      const images = Object.values(entry.outputs ?? {}).flatMap((output) => output?.images ?? []);
      if (images.length > 0) return { promptId: queued.prompt_id, imageCount: images.length };
      if (entry.status?.completed) throw new Error(`${label}: completed without an image output`);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`${label}: timed out`);
}

const parentBytes = await sharp({
  create: { width: 512, height: 512, channels: 3, background: { r: 92, g: 108, b: 128 } }
}).png().toBuffer();
const maskBytes = await sharp({
  create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } }
}).composite([{ input: Buffer.from('<svg width="256" height="256"><rect width="256" height="256" fill="white"/></svg>'), left: 128, top: 128 }]).png().toBuffer();

const dummyName = await upload("guruguru-anima-dummy.png", parentBytes);
const parentName = await upload("guruguru-anima-parent.png", parentBytes);
const maskName = await upload("guruguru-anima-mask.png", maskBytes);
const commonRequest = {
  templateId: "anima-check",
  prompt: "masterpiece, best quality, score_7, safe, 1girl, solo, blue hair, white background",
  negativePrompt: "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts",
  seed: 123456,
  seedMode: "fixed",
  batchSize: 1,
  steps: 8,
  cfg: 4,
  sampler: "er_sde",
  scheduler: "simple",
  denoise: 1,
  width: 512,
  height: 512,
  parentAssetId: null,
  relationType: null,
  inpaint: null,
  controlnet: null
};
const featureAvailability = { controlnet: false, pulid: false };

const txt2imgPrompt = patchUnifiedSwitchWorkflow(
  structuredClone(workflow),
  {
    projectId: "anima-check",
    roundIndex: 1,
    request: { ...commonRequest, generationMode: "txt2img" },
    dummyImageName: dummyName,
    featureAvailability
  },
  "guruguru/anima-check/txt2img"
);
const txt2img = await queueAndWait(txt2imgPrompt, "txt2img");

const inpaintPrompt = patchUnifiedSwitchWorkflow(
  structuredClone(workflow),
  {
    projectId: "anima-check",
    roundIndex: 2,
    request: {
      ...commonRequest,
      generationMode: "img2img",
      denoise: 0.7,
      parentAssetId: "synthetic-parent",
      inpaint: {
        maskDataUrl: null,
        maskPath: "synthetic-mask",
        maskedContent: "original",
        inpaintArea: "only_masked",
        onlyMaskedPadding: 6
      }
    },
    uploadedImageName: parentName,
    uploadedMaskName: maskName,
    dummyImageName: dummyName,
    featureAvailability
  },
  "guruguru/anima-check/inpaint"
);
const inpaint = await queueAndWait(inpaintPrompt, "inpaint");

console.log(JSON.stringify({ ok: true, comfyui: baseUrl, txt2img, inpaint }, null, 2));
