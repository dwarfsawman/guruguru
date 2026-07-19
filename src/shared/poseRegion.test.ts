import assert from "node:assert/strict";
import test from "node:test";
import { findPosePreset, presetToPosePoints } from "./posePresetLibrary.ts";
import { poseBodyScale, poseCharacterBounds, poseCharacterSilhouette } from "./poseRegion.ts";
import type { PosePoint } from "./poseTypes.ts";

function standingJoints(): PosePoint[] {
  return presetToPosePoints(findPosePreset("standing")!.points, []);
}

test("poseBodyScale: 胴長基準、退化時は外接箱対角へフォールバック", () => {
  const joints = standingJoints();
  // standing の首(0.5,0.2)→ヒップ中点(0.5,0.5) = 0.3。
  assert.ok(Math.abs(poseBodyScale(joints) - 0.3) < 1e-9);
  const flat = joints.map((joint) => ({ ...joint, x: 0.5, y: 0.5 }));
  assert.ok(poseBodyScale(flat) > 0, "全関節同一点でも正のスケール");
});

test("poseCharacterBounds: 可視関節を体格マージン込みで包む(頭上広め)", () => {
  const joints = standingJoints();
  const bounds = poseCharacterBounds(joints)!;
  assert.ok(bounds, "standing で bounds が得られる");
  for (const joint of joints.filter((entry) => entry.visible)) {
    assert.ok(joint.x >= bounds.x && joint.x <= bounds.x + bounds.width, `x=${joint.x}`);
    assert.ok(joint.y >= bounds.y && joint.y <= bounds.y + bounds.height, `y=${joint.y}`);
  }
  // 頭上マージン(0.55*scale)は下(0.25*scale)より広い。
  const minY = Math.min(...joints.filter((entry) => entry.visible).map((entry) => entry.y));
  const maxY = Math.max(...joints.filter((entry) => entry.visible).map((entry) => entry.y));
  assert.ok(minY - bounds.y > (bounds.y + bounds.height) - maxY, "頭上が広い");
  // 全関節不可視は null。
  assert.equal(poseCharacterBounds(joints.map((joint) => ({ ...joint, visible: false }))), null);
  // 見切れ骨格は [-1,2] でクランプされる。
  const bleed = joints.map((joint) => ({ ...joint, y: joint.y + 1.2 }));
  const bleedBounds = poseCharacterBounds(bleed)!;
  assert.ok(bleedBounds.y + bleedBounds.height <= 2 + 1e-9);
});

test("poseCharacterSilhouette: 可視関節を全て含む凸多角形を返す", () => {
  const joints = standingJoints();
  const hull = poseCharacterSilhouette(joints)!;
  assert.ok(hull && hull.length >= 3);
  // 凸性: 連続する辺の外積の符号が一定。
  const signs = hull.map((point, index) => {
    const a = hull[(index + 1) % hull.length]!;
    const b = hull[(index + 2) % hull.length]!;
    return Math.sign((a.x - point.x) * (b.y - a.y) - (a.y - point.y) * (b.x - a.x));
  }).filter((sign) => sign !== 0);
  assert.ok(signs.every((sign) => sign === signs[0]), "凸包");
  // 全可視関節が包内(convexity + 包含判定: 各辺に対して同じ側)。
  for (const joint of joints.filter((entry) => entry.visible)) {
    const inside = hull.every((point, index) => {
      const next = hull[(index + 1) % hull.length]!;
      const cross = (next.x - point.x) * (joint.y - point.y) - (next.y - point.y) * (joint.x - point.x);
      return signs[0]! >= 0 ? cross >= -1e-9 : cross <= 1e-9;
    });
    assert.ok(inside, `joint (${joint.x},${joint.y}) が包内`);
  }
  assert.equal(poseCharacterSilhouette([joints[0]!]), null, "1点では作れない");
});
