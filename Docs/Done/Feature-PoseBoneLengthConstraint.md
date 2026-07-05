# ポーズ編集の回転拘束（Shift ドラッグで骨長固定）

- ステータス: 実装済み
- 最終更新: 2026-07-04
- 関連: `Docs/Done/Feature-PoseControlNet.md`（ポーズ編集の基盤）

## 概要

ポーズ編集で関節を **Shift を押しながらドラッグ**すると、親関節を中心にドラッグ開始時の骨長を保ったまま回転する（回転拘束）。OpenPose ControlNet は骨長を体型プロポーションとして解釈するため、自由ドラッグで骨長が崩れると「ポーズ変更」ではなく「体型変更」として生成に影響してしまう問題への対応。

通常ドラッグ（Shift なし）は従来通り自由移動。検出ミスの修正など骨長自体を変えたいケースがあるため、拘束はオプトイン。Shift はドラッグ中の押下/解放がそのつど反映される。

## 実装

### pure helpers（`src/client/poseDraft.ts`）

- `OPENPOSE_JOINT_PARENT`: joint index → 親 joint index の固定表。`OPENPOSE_BONES` の [親, 子] ペアから導出。neck(1) はルートで親なし
- `poseBoneConstraintForJoint(points, jointIndex)`: ドラッグ開始時に拘束（anchor=親座標, radius=親子間距離）を返す。親なし / 点欠落 / 骨長 0 は null（拘束なし）。親の visible は問わない
- `projectPointToBoneCircle(constraint, x, y)`: ポインタ座標を拘束円上へ射影。ポインタが anchor と一致する縮退ケースは anchor の +x 方向の点を返す

### main.ts

- `ActivePoseJointDrag.constraint`: `beginPoseJointDrag` で捕捉（radius はドラッグ開始時点の骨長）
- `continuePoseJointDrag`: `event.shiftKey && constraint` のとき射影 → `clampPointToPoseBounds` の順で適用し、結果を `drag.current` へ保存（画像端でははみ出し防止を優先し骨長が縮み得る）。`finishPoseJointDrag` は従来通り `drag.current` をコミットするため表示とコミット座標が一致する

## テスト

`src/client/poseDraft.test.ts`: 親表と `OPENPOSE_BONES` の整合、拘束の anchor/radius、null ケース、射影の距離保存・縮退ケース。
