# ポーズ検出モデル選択（Full / Heavy）

- ステータス: 実装済み
- 最終更新: 2026-07-04
- 関連: `Docs/Done/Feature-PoseControlNet.md`

## 概要

ポーズタブのモデルカードに select を追加し、MediaPipe Pose Landmarker の **Full（~9MB、既定）** と **Heavy（~29MB、高精度）** を切り替えられるようにした。Heavy の `.task` は Full と同じ GitHub release `pose-models-v1` にアップロード済みで、既存のサーバプロキシ `/api/pose-models/<filename>` 経由で配信される。

## 実装

- `src/client/pose/models.ts`: `POSE_MODELS` に `pose-landmarker-heavy`（`pose_landmarker_heavy.task`, 30,664,242 bytes）を追加。`poseModelById(id)` を追加（未知 id は null → 呼び出し側で `defaultPoseModel()` へフォールバック）
- `src/client/pose/types.ts`: `PoseModelDefinition.id` を union に拡張
- `src/client/poseTypes.ts` / `poseDraft.ts`: `PoseDraft.modelId` を追加（既定は `defaultPoseModel().id`）。`normalizePoseDraft` は modelId 欠落の旧ドラフトを既定値で補う（後方互換）
- `src/client/views/posePanel.ts`: モデルカードのラベルを `data-pose-field="modelId"` の select に置換。ダウンロード/初期化/検出中は disabled
- `src/client/main.ts`:
  - `updatePoseDraftFromControl`: modelId 変更時に `modelStatus` を `idle` に戻す（worker セッションは次回ロード時に `load-model` で張り替わる）。検出済み points は保持
  - `loadActivePoseModel`: `poseModelById(draft.modelId) ?? defaultPoseModel()` を使用
- `src/server/index.ts`: `releaseAssetRegistry` に `pose_landmarker_heavy.task` を追加

## 備考

- モデル選択は PoseDraft（アセット単位）に保持される。modelStatus 等が元々 draft 単位で持たれている既存構造に合わせた
- worker 側 (`pose/worker.ts`) は `model.modelFile` をキャッシュキーにしているため、Full/Heavy は OPFS 上で別ファイルとして共存キャッシュされる
