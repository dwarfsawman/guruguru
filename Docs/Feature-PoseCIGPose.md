# CIGPose ポーズ検出（top-down / onnxruntime-web）

- ステータス: 実装済み
- 最終更新: 2026-07-04
- 関連: `Docs/Feature-PoseModelSelection.md` / `Docs/Done/Feature-PoseControlNet.md`

## 概要

ポーズタブのモデル選択に **CIGPose**（CVPR 2026, Apache-2.0）系の top-down モデルを追加した。MediaPipe Pose Landmarker（Full/Heavy, ~9/29MB, ブラウザ内 WASM）より大幅に高精度で、GPU（WebGPU）前提の重量モデル。COCO-WholeBody で SOTA 級（本体 AP は MediaPipe を大きく上回る）。

- **CIGPose L**（`cigpose-l_coco_384x288.onnx`, 17点 COCO body, ~113MB）
- **CIGPose X**（`cigpose-x_coco-wholebody_384x288.onnx`, 133点 wholebody の先頭17点を body に使用, ~240MB, 最重量・最高精度）

いずれも人物検出器 **YOLOX-Nano**（`yolox_nano.onnx`, ~3.66MB）を併用する top-down パイプライン。検出→切り出し→姿勢推定を人物ごとに実行し、最大 `MAX_POSE_COUNT`(=4) 人まで返す。

## アーキテクチャ判断

- **別 worker（`src/client/pose/cigposeWorker.ts` → `/pose-cigpose-worker.js`, ESM/module worker）**。MediaPipe は wasm グルーが classic worker 必須、onnxruntime-web は `import.meta` を使うため module worker 必須で同居不可。両者は同じ `PoseWorkerRequest`/`PoseWorkerResponse` を話し、`main.ts` が `model.kind`（`poseWorkerKind()`）で送信先 worker を振り分ける。既存 MediaPipe 経路（`pose/worker.ts`）は無改変。
- **出力は MediaPipe 33 landmark レイアウトで返す**。CIGPose の COCO 17点を、既存 `poseDraft.ts` の `mediapipeToOpenPose` が読むスロット（`COCO17_TO_MEDIAPIPE33 = [0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28]`）へ詰める。これにより下流（OpenPose 18点変換・関節ドラッグ編集・スケルトン PNG・ControlNet 添付）は完全に無改変で流用できる。
- **onnxruntime-web は WebSAM worker と同一パターン**（`import("onnxruntime-web/webgpu")`, `wasmPaths="/ort/"`, WebGPU→WASM フォールバック, OPFS キャッシュ）。

## パイプライン（`namas191297/cigpose-onnx` の run_onnx.py を移植）

1. **YOLOX-Nano 検出**: letterbox 416（余白 114, RGB, 正規化なし）→ grid+stride デコード（stride 8/16/32, obj*cls は graph 内で sigmoid 済み）→ conf 0.5 / NMS 0.45 → box を `/ratio` で元座標へ。person(class 0) のみ。
2. **切り出し前処理**: bbox を入力アスペクト(288/384)へ合わせ ×1.25 padding → 元画像内へクランプ → 288×384 へリサイズ → ImageNet 正規化（mean [123.675,116.28,103.53] / std [58.395,57.12,57.375], RGB）→ NCHW `[1,3,384,288]`。
3. **CIGPose 推論**: 出力 `simcc_x[1,K,576]` / `simcc_y[1,K,768]`（K=17 or 133, split_ratio=2.0）。
4. **SimCC デコード**: 各キーポイントで argmax → `/split_ratio` で入力座標 → crop へ線形リマップ → 元画像 → 正規化。score=min(max_x,max_y) を `visibility`(clamp 0..1) に。先頭17点のみ使用。

前処理/後処理定数・SimCC bin 数・split_ratio は ONNX 埋め込みメタ（`cigpose_meta`）で検証済み。

## 実装ファイル

- `src/shared/constants.ts`: `GITHUB_POSE_CIGPOSE_RELEASE_API_URL`（release `pose-cigpose-v1`）を追加
- `src/server/index.ts`: `releaseAssetRegistry` に `yolox_nano.onnx` / `cigpose-l_coco_384x288.onnx` / `cigpose-x_coco-wholebody_384x288.onnx` を追加（既存 proxy `/api/pose-models/<file>` で GitHub Release から配信）
- `src/client/pose/types.ts`: `PoseModelKind` / `PoseKeypointLayout` を追加。`PoseModelDefinition` に `kind`/`detectorFile`/`detectorSize`/`poseSize`/`inputWidth`/`inputHeight`/`splitRatio`/`keypointLayout`、`PoseModelUrls` に `detectorUrl` を追加。`id` を string へ拡張
- `src/client/pose/models.ts`: `cigpose-l`/`cigpose-x` を `POSE_MODELS` に追加。`buildPoseModelUrls` を detector URL 対応に。`isCigposeModel` を追加
- `src/client/pose/cigposeWorker.ts`（新規）: 上記パイプライン
- `scripts/build.mjs`: `pose-cigpose-worker.ts` を ESM で `dist/public/pose-cigpose-worker.js` へバンドル
- `src/client/main.ts`: `poseCigposeWorker` と `poseWorkerKind()`/`ensurePoseWorker(kind)`/`postPoseMessage(msg, kind)` で振り分け。`destroyPoseWorkerSession` は両 worker に destroy 送信
- `src/client/poseDraft.test.ts`: モデル一覧・cigpose 設定・detector URL のテストを更新/追加

## モデル配布

- GitHub Release **`pose-cigpose-v1`**（private repo `chainsaw-clara-beau/guruguru`）に 3 アセットをアップロード。元は `namas191297/cigpose-onnx` v1.0.0（1.64GB zip）から必要分のみ抽出してミラー
- クライアントは既定 base URL `/api/pose-models` → サーバ proxy が `GURUGURU_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` でトークン付き取得しストリーム
- OPFS キャッシュは MediaPipe pose と同じ `guruguru-pose-models`（ファイル名が別なので共存）

## 検証

- `npm run typecheck` / `npm test`(297 pass) / `npm run build` OK
- 配布 proxy: `/api/pose-models/yolox_nano.onnx`=200・3,659,407B・ONNX ヘッダ確認、`cigpose-l`=200・113,577,664B、未登録=404
- **ブラウザ E2E（WebGPU）**: 実写人物画像で worker を load→detect。backend=GPU、YOLOX が 1 人検出、CIGPose-L の 17点が Python リファレンス（onnxruntime CPU）とサブピクセル一致（nose/肩/膝/足首を照合）。COCO17→MediaPipe33 スロットも正しく（左肩→MP11 等）、下流の OpenPose 変換にそのまま乗ることを確認
- Python 側フル移植検証（YOLOX+CIGPose-L）で実写スコア 0.34〜0.89、`visibility>=0.5` 閾値が妥当なことを確認

## 変えないこと

- MediaPipe 経路（`pose/worker.ts`）・既存 pose モデル（Full/Heavy）・下流の OpenPose 変換/編集/PNG/ControlNet 添付・API path/response・DB 保存形式
- CIGPose は wholebody でも body 17点のみ使用（手/顔キーポイントは将来スコープ）

## 未決事項 / 将来

- wholebody の手・顔キーポイント活用（現状は先頭17点のみ）
- リアルタイム（動画）用途は未対応（1枚検出のみ）。X(240MB) は DL が重い
