import { test } from "node:test";
import assert from "node:assert/strict";
import { childHue, iterationEdgeAttachmentsHtml, iterationEdgePopoutHtml, promptSynopsis, rootHue } from "./iterationTree.ts";
import type { Round } from "../../shared/apiTypes.ts";

function round(overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    projectId: "project-1",
    templateId: "template-1",
    parentRoundId: null,
    roundIndex: 0,
    promptId: null,
    status: "completed",
    generationMode: "txt2img",
    branchColorIndex: 0,
    branchReason: null,
    branchKey: null,
    request: {
      templateId: "template-1",
      prompt: "",
      negativePrompt: "",
      seed: null,
      seedMode: "fixed",
      batchSize: 1,
      steps: 20,
      cfg: 7,
      sampler: "",
      scheduler: "",
      denoise: 1,
      width: 512,
      height: 512,
      generationMode: "txt2img"
    },
    createdAt: "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

test("rootHue: branchColorIndex 0 is hue 0", () => {
  assert.equal(rootHue(round({ branchColorIndex: 0 })), 0);
});

test("rootHue: increments by ROOT_HUE_STEP (57) per branchColorIndex", () => {
  assert.equal(rootHue(round({ branchColorIndex: 1 })), 57);
  assert.equal(rootHue(round({ branchColorIndex: 2 })), 114);
});

test("rootHue: wraps at 360 for large branchColorIndex", () => {
  // 7 * 57 = 399 -> 399 % 360 = 39
  assert.equal(rootHue(round({ branchColorIndex: 7 })), 39);
});

test("rootHue: missing branchColorIndex defaults to 0", () => {
  assert.equal(rootHue(round({ branchColorIndex: undefined as unknown as number })), 0);
});

test("childHue: denoise 0 keeps the parent hue unchanged", () => {
  assert.equal(childHue(100, 0), 100);
});

test("childHue: denoise 0.35 adds 14 degrees (CHILD_HUE_STEP_MAX * 0.35)", () => {
  assert.equal(childHue(100, 0.35), 114);
});

test("childHue: denoise 1.0 adds the full CHILD_HUE_STEP_MAX (40 degrees)", () => {
  assert.equal(childHue(100, 1.0), 140);
});

test("childHue: denoise above 1 is clamped to 1", () => {
  assert.equal(childHue(100, 1.5), 140);
  assert.equal(childHue(100, 100), 140);
});

test("childHue: denoise below 0 is clamped to 0", () => {
  assert.equal(childHue(100, -0.5), 100);
  assert.equal(childHue(100, -100), 100);
});

test("childHue: wraps around 360", () => {
  assert.equal(childHue(350, 1.0), 30); // 350 + 40 = 390 -> 30
});

test("childHue: normalizes a negative parent hue into 0..360", () => {
  assert.equal(childHue(-10, 0), 350);
});

test("childHue: a deep chain of low-denoise generations does not wrap a full 360 degrees", () => {
  let hue = rootHue(round({ branchColorIndex: 0 }));
  for (let generation = 0; generation < 10; generation++) {
    hue = childHue(hue, 0.35);
  }
  // 14 degrees per generation * 10 generations = 140 degrees, well under 360.
  assert.equal(hue, 140);
  assert.ok(hue < 360);
});

test("promptSynopsis: reports the normalized character count", () => {
  assert.deepEqual(promptSynopsis("a cat"), { charCount: 5, text: "a cat" });
});

test("promptSynopsis: collapses whitespace/newlines before counting", () => {
  assert.deepEqual(promptSynopsis("  a   cat\n\nsitting  "), { charCount: 13, text: "a cat sitting" });
});

test("promptSynopsis: truncates to 140 chars with an ellipsis and still counts the full length", () => {
  const long = "x".repeat(200);
  const result = promptSynopsis(long);
  assert.equal(result.charCount, 200);
  assert.equal(result.text.length, 141); // 140 chars + ellipsis
  assert.ok(result.text.endsWith("…"));
});

test("promptSynopsis: empty prompt yields zero count and empty text", () => {
  assert.deepEqual(promptSynopsis(""), { charCount: 0, text: "" });
});

test("iterationEdgePopoutHtml: includes prompt char count, resolution, denoise, and steps", () => {
  const html = iterationEdgePopoutHtml(
    round({
      roundIndex: 3,
      request: {
        templateId: "t",
        prompt: "a serene mountain lake",
        negativePrompt: "",
        seed: 1,
        seedMode: "fixed",
        batchSize: 1,
        steps: 28,
        cfg: 6.5,
        sampler: "euler",
        scheduler: "karras",
        denoise: 0.55,
        width: 1024,
        height: 768,
        generationMode: "img2img"
      }
    })
  );
  assert.match(html, /22文字/); // "a serene mountain lake".length === 22
  assert.match(html, /a serene mountain lake/);
  assert.match(html, /1024×768/);
  assert.match(html, /0\.55/);
  assert.match(html, /28/);
  assert.match(html, /euler/);
});

test("iterationEdgePopoutHtml: escapes HTML in the prompt", () => {
  const html = iterationEdgePopoutHtml(
    round({ request: { ...round().request, prompt: "<script>alert(1)</script>" } })
  );
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("iterationEdgePopoutHtml: shows a placeholder when the prompt is empty", () => {
  const html = iterationEdgePopoutHtml(round({ request: { ...round().request, prompt: "" } }));
  assert.match(html, /プロンプトなし/);
  assert.match(html, /0文字/);
});

function pastedObject(id: string, sourceId: string) {
  return {
    id,
    sourceId,
    sourceWidth: 10,
    sourceHeight: 10,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
  };
}

test("iterationEdgeAttachmentsHtml: empty when the round has no paste attachments", () => {
  assert.equal(iterationEdgeAttachmentsHtml(round()), "");
  assert.equal(
    iterationEdgeAttachmentsHtml(round({ request: { ...round().request, pasteComposite: { objects: [] } } })),
    ""
  );
});

test("iterationEdgeAttachmentsHtml: renders footer count and paste-source thumbnails", () => {
  const html = iterationEdgeAttachmentsHtml(
    round({
      request: {
        ...round().request,
        pasteComposite: { objects: [pastedObject("o1", "pastesrc_a"), pastedObject("o2", "pastesrc_b")] }
      }
    })
  );
  assert.match(html, /添付 2件/);
  assert.match(html, /\/api\/projects\/project-1\/paste-sources\/pastesrc_a/);
  assert.match(html, /\/api\/projects\/project-1\/paste-sources\/pastesrc_b/);
  assert.match(html, /貼り付け画像 1/);
  assert.match(html, /data-edge-attachment-preview-image/);
  assert.match(html, /iteration-edge-attachments-footer/);
});

test("iterationEdgeAttachmentsHtml: includes mask and pose attachments independently", () => {
  const html = iterationEdgeAttachmentsHtml(
    round({
      request: {
        ...round().request,
        inpaint: {
          maskDataUrl: null,
          maskPath: "C:/data/project/masks/round_mask.png",
          maskedContent: "original",
          inpaintArea: "only_masked",
          onlyMaskedPadding: 32
        },
        controlnet: {
          poseImageDataUrl: null,
          poseImagePath: "C:/data/project/control/round_pose.png",
          strength: 1,
          startPercent: 0,
          endPercent: 1
        }
      }
    })
  );
  assert.match(html, /添付 2件/);
  assert.match(html, /\/api\/rounds\/round-1\/attachments\/mask/);
  assert.match(html, /\/api\/rounds\/round-1\/attachments\/pose/);
  assert.match(html, /マスク形状/);
  assert.match(html, /ポーズ画像/);
});

test("iterationEdgePopoutHtml: includes the attachments footer only when attachments exist", () => {
  assert.ok(!iterationEdgePopoutHtml(round()).includes("iteration-edge-attachments-footer"));
  const withAttachments = iterationEdgePopoutHtml(
    round({ request: { ...round().request, pasteComposite: { objects: [pastedObject("o1", "pastesrc_a")] } } })
  );
  assert.match(withAttachments, /添付 1件/);
});
