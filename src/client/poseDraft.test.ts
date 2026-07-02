import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPoseDraft,
  hasActivePoseData,
  mediapipeToOpenPose,
  normalizePoseDraft,
  poseDraftHasAttachment
} from "./poseDraft.ts";
import type { PoseWorkerLandmark } from "./pose/types.ts";
import type { PoseDraft, PosePoint } from "./poseTypes.ts";
import { OPENPOSE_JOINT_COUNT, OPENPOSE_JOINT_NAMES } from "./poseTypes.ts";

function makeLandmarks(overrides: Record<number, Partial<PoseWorkerLandmark>> = {}): PoseWorkerLandmark[] {
  const landmarks: PoseWorkerLandmark[] = [];
  for (let index = 0; index < 33; index += 1) {
    landmarks.push({
      x: index / 100,
      y: index / 200,
      z: 0,
      visibility: 0.9,
      ...overrides[index]
    });
  }
  return landmarks;
}

function makePoints(): PosePoint[] {
  return Array.from({ length: OPENPOSE_JOINT_COUNT }, (_, index) => ({
    x: index,
    y: index,
    visible: true
  }));
}

test("OPENPOSE_JOINT_NAMES: has 18 joints in COCO order", () => {
  assert.equal(OPENPOSE_JOINT_COUNT, 18);
  assert.equal(OPENPOSE_JOINT_NAMES[0], "nose");
  assert.equal(OPENPOSE_JOINT_NAMES[1], "neck");
  assert.equal(OPENPOSE_JOINT_NAMES[8], "rHip");
  assert.equal(OPENPOSE_JOINT_NAMES[17], "lEar");
});

test("defaultPoseDraft: sets documented defaults", () => {
  const draft = defaultPoseDraft("asset-1");
  assert.equal(draft.parentAssetId, "asset-1");
  assert.equal(draft.enabled, false);
  assert.equal(draft.points, null);
  assert.equal(draft.source, "detected");
  assert.equal(draft.strength, 1);
  assert.equal(draft.startPercent, 0);
  assert.equal(draft.endPercent, 1);
  assert.equal(draft.modelStatus, "idle");
  assert.equal(draft.imageWidth, null);
  assert.equal(draft.imageHeight, null);
});

test("normalizePoseDraft: fills in defaults for missing fields via spread", () => {
  const partial = { parentAssetId: "asset-2" } as PoseDraft;
  const normalized = normalizePoseDraft(partial);
  assert.equal(normalized.strength, 1);
  assert.equal(normalized.startPercent, 0);
  assert.equal(normalized.endPercent, 1);
  assert.equal(normalized.points, null);
  assert.equal(normalized.modelStatus, "idle");
});

test("normalizePoseDraft: preserves provided points and settings", () => {
  const points = makePoints();
  const draft: PoseDraft = {
    ...defaultPoseDraft("asset-3"),
    enabled: true,
    points,
    source: "edited",
    strength: 0.7,
    startPercent: 0.1,
    endPercent: 0.9
  };
  const normalized = normalizePoseDraft(draft);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.points, points);
  assert.equal(normalized.source, "edited");
  assert.equal(normalized.strength, 0.7);
  assert.equal(normalized.startPercent, 0.1);
  assert.equal(normalized.endPercent, 0.9);
});

test("mediapipeToOpenPose: returns 18 points scaled to natural px", () => {
  const landmarks = makeLandmarks();
  const points = mediapipeToOpenPose(landmarks, 1000, 500);
  assert.equal(points.length, 18);
  // nose = MediaPipe index 0
  assert.equal(points[0]!.x, landmarks[0]!.x * 1000);
  assert.equal(points[0]!.y, landmarks[0]!.y * 500);
  assert.equal(points[0]!.visible, true);
  // rShoulder = MediaPipe index 12
  assert.equal(points[2]!.x, landmarks[12]!.x * 1000);
  assert.equal(points[2]!.y, landmarks[12]!.y * 500);
  // lWrist = MediaPipe index 15
  assert.equal(points[7]!.x, landmarks[15]!.x * 1000);
  // rAnkle = MediaPipe index 28
  assert.equal(points[10]!.x, landmarks[28]!.x * 1000);
  // lEar = MediaPipe index 7
  assert.equal(points[17]!.x, landmarks[7]!.x * 1000);
});

test("mediapipeToOpenPose: neck is midpoint of both shoulders", () => {
  const landmarks = makeLandmarks({
    11: { x: 0.6, y: 0.3, visibility: 0.9 },
    12: { x: 0.4, y: 0.5, visibility: 0.9 }
  });
  const points = mediapipeToOpenPose(landmarks, 100, 100);
  const neck = points[1]!;
  assert.equal(neck.x, ((0.6 + 0.4) / 2) * 100);
  assert.equal(neck.y, ((0.3 + 0.5) / 2) * 100);
  assert.equal(neck.visible, true);
});

test("mediapipeToOpenPose: visibility below 0.5 marks point invisible", () => {
  const landmarks = makeLandmarks({
    0: { visibility: 0.4 },
    16: { visibility: 0.49 }
  });
  const points = mediapipeToOpenPose(landmarks, 100, 100);
  assert.equal(points[0]!.visible, false); // nose
  assert.equal(points[4]!.visible, false); // rWrist = MediaPipe 16
  assert.equal(points[2]!.visible, true); // rShoulder stays visible
});

test("mediapipeToOpenPose: neck visibility uses average of shoulder visibilities", () => {
  const landmarks = makeLandmarks({
    11: { visibility: 0.2 },
    12: { visibility: 0.6 }
  });
  const points = mediapipeToOpenPose(landmarks, 100, 100);
  assert.equal(points[1]!.visible, false); // (0.2+0.6)/2 = 0.4 < 0.5
});

test("mediapipeToOpenPose: missing landmarks fall back to invisible origin", () => {
  const points = mediapipeToOpenPose([], 100, 100);
  assert.equal(points.length, 18);
  for (const point of points) {
    assert.deepEqual(point, { x: 0, y: 0, visible: false });
  }
});

test("hasActivePoseData: requires enabled and full 18 points", () => {
  const base = defaultPoseDraft("asset-4");
  assert.equal(hasActivePoseData(null), false);
  assert.equal(hasActivePoseData(base), false);
  assert.equal(hasActivePoseData({ ...base, enabled: true }), false);
  assert.equal(hasActivePoseData({ ...base, enabled: true, points: makePoints().slice(0, 5) }), false);
  assert.equal(hasActivePoseData({ ...base, enabled: true, points: makePoints() }), true);
  assert.equal(hasActivePoseData({ ...base, enabled: false, points: makePoints() }), false);
});

test("poseDraftHasAttachment: mirrors hasActivePoseData", () => {
  const base = defaultPoseDraft("asset-5");
  assert.equal(poseDraftHasAttachment(base), false);
  assert.equal(poseDraftHasAttachment({ ...base, enabled: true, points: makePoints() }), true);
});
