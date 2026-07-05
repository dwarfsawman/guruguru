# ポーズ検出の複数人対応（最大4人）

- ステータス: 実装済み
- 最終更新: 2026-07-04
- 関連: `Docs/Done/Feature-PoseControlNet.md`、`Docs/Feature-PoseBoneLengthConstraint.md`、`Docs/Feature-PoseModelSelection.md`

## 概要

ポーズ検出・編集・ControlNet 添付を最大 **4人**（`MAX_POSE_COUNT`、`src/client/poseTypes.ts`）まで対応させた。OpenPose ControlNet は1枚の骨格画像に複数人分のスケルトンを描いても解釈できるため、骨格PNGは全員分を黒背景1枚に描画する。

## データモデル

- `PoseDraft.points: PosePoint[] | null`（1人分）→ **`poses: PosePoint[][] | null`**（人ごとの18点の配列）へ変更
- 旧フォーマット移行: `normalizePoseDraft` が localStorage 由来の旧 draft（`points` 18点）を `poses: [points]` に包み、`points` キーは除去する。`poseDraftForAsset` 経由で必ず normalize されるため再検出不要

## 変更点

- `pose/worker.ts`: PoseLandmarker を `numPoses: MAX_POSE_COUNT` で初期化（応答は元から `landmarks[][]`）
- `poseDraft.ts`: `mediapipePosesToOpenPose(landmarksList, w, h)` を追加（空 landmarks を除外し `MAX_POSE_COUNT` 人に切り詰め、各人を `mediapipeToOpenPose` で変換）。`hasActivePoseData` は「1人以上かつ全員が18点」を要求
- `main.ts` 検出ハンドラ: 全員分を取り込み。ステータスは2人以上で「検出完了（N人）」
- `poseSkeleton.ts`: `buildPoseSkeletonDrawOps` / `renderPoseSkeletonDataUrl` が `PosePoint[][]` を受け、人ごとに bone→joint の順で描画
- `posePanel.ts`: オーバーレイは人ごとに `data-pose-index` を付与。関節カウントは全員合算（2人以上は「N人 · 関節 x/y」）
- 関節ドラッグ（`main.ts`）: `ActivePoseJointDrag.poseIndex` を追加し、joint/bone のセレクタを `[data-pose-index]` で絞る。回転拘束（Shift）は該当ポーズの点列に対して従来通り機能。コミットは `poses` の該当ポーズのみ差し替え

## 制約・備考

- MediaPipe Pose Landmarker の複数人検出は、人物が大きく重なる構図では検出漏れ・混線が起き得る（OpenPose/DWPose ほど頑健ではない）。離れて立つ2〜4人構図が実用範囲
- Strength / Start / End は draft 単位（全員共通）。人ごとの個別 strength は ControlNet の仕組み上も1枚のconditioning に畳まれるため対象外
