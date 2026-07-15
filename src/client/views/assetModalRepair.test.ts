import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "../../shared/apiTypes.ts";
import { defaultInpaintDraft } from "../maskDraft.ts";
import { renderPreviewFooter } from "./assetModal.ts";

const asset = { id: "asset-repair", prompt: "frozen prompt" } as Asset;
const context = { taskId: "task-repair", assetId: asset.id, busy: false };

test("asset modal exposes task repair only for a valid committed PNG mask", () => {
  const empty = renderPreviewFooter(asset, "info", defaultInpaintDraft(asset.id), context);
  assert.match(empty, /data-action="repair-script-manga-candidate"/);
  assert.match(empty, /disabled/);
  assert.match(empty, /白い修復範囲/);

  const draft = {
    ...defaultInpaintDraft(asset.id),
    maskDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    enabled: true
  };
  const ready = renderPreviewFooter(asset, "info", draft, context);
  assert.match(ready, /data-id="task-repair" data-asset-id="asset-repair"/);
  assert.doesNotMatch(ready, /data-action="repair-script-manga-candidate"[\s\S]*?disabled/);
  assert.doesNotMatch(ready, /白い修復範囲/);

  const ordinary = renderPreviewFooter(asset, "info", draft, null);
  assert.doesNotMatch(ordinary, /repair-script-manga-candidate/);
});
