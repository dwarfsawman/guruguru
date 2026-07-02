# 人物ポーズ ControlNet 機能（MediaPipe Pose Landmarker）

- ステータス: 設計（未着手）
- 最終更新: 2026-07-02
- 参照ワークフロー: `Docs/ReferenceFlows/ComfyUI_00147_controlnet.json`

## 概要

親画像から MediaPipe Pose Landmarker Full で人物ポーズを検出し、関節をドラッグ編集した上で OpenPose 形式のスケルトン画像を生成。これを ControlNet（`ControlNetApplyAdvanced`）の control image として生成リクエストに添付する。マスク編集と同じモーダル内でタブ切替して編集し、グリッドには棒人間アイコンの ControlNet バッジを表示する。

## ユーザー確認済みの決定事項

- **タブ配置**: アセット詳細モーダルのマスク編集サイドバー「スマート選択」パネルのヘッダー右（スクリーンショットの赤枠位置）に「マスク / ポーズ」タブを置き、パネル内容を切り替える。
- **ポーズ編集**: 検出結果を初期値として関節をドラッグ編集できる。
- **ControlNet モデル本体**: ComfyUI 側に設置済み前提。テンプレート JSON の `ControlNetLoader.control_net_name`（例: `diffusion_pytorch_model.safetensors`）はアプリからは変更しない。
- **ポーズ検出モデルの配布**: SAM モデルと同様に GitHub Release からダウンロードする。
- **バッジ**: MASK バッジと同様に「次回生成に添付される」ことを示す draft 駆動のバッジ（棒人間アイコン）。

## 参照ワークフローの構成（調査済み）

Chroma 系 t2i + ControlNet。要点:

- 生成本体: `UNETLoader`(731, Chroma1-HD) → `ModelSamplingAuraFlow`(701) → `CFGGuider`(694) / `BasicScheduler`(734: steps/denoise/scheduler) / `KSamplerSelect`(700) / `RandomNoise`(718: noise_seed) / `EmptySD3LatentImage`(737) → `SamplerCustomAdvanced`(747) → `VAEDecode`(298) → `SaveImage`(740)
- ControlNet: **`ControlNetApplyAdvanced`(752)**（`strength` / `start_percent` / `end_percent`、positive←748・negative←749 の conditioning を挟んで `CFGGuider` へ）、`ControlNetLoader`(753)、**`LoadImage`(754) が control image を供給**
- 754 の `image` 値 `round_*_mask.png` は inpaint マスクの残骸（`storeMaskImage` の命名 `{roundId}_mask.png` 由来）。実行時にアプリが必ず上書きする前提の値
- **755 は未接続の迷子 `ControlNetLoader`**。どのノードからも参照されず実行もされないが、「ControlNetLoader が複数あるケース」の教訓として、ノード特定は class 検索ではなく `ControlNetApplyAdvanced.inputs.control_net` / `inputs.image` の connection を辿る方式を採る
- 既存 `inferRoleMap`（`src/shared/workflowRoleMap.ts:10-58`）はこの JSON に対して seed(`718.noise_seed`)/cfg(`694`)/steps・denoise・scheduler(`734`)/sampler(`700`)/width・height・batch(`737`)/prompt(748/749)/save(740) を正しく推論できる（実トレースで確認済み）。ただし誤推論が 2 つある:
  1. `load_image_input` が 754（control 用 LoadImage）に推論される（後述の一括注入問題）
  2. `vae_encode_image_input` が **752（`ControlNetApplyAdvanced`）の `inputs.image`** に誤推論される。VAEEncode 系ノードが無いためフォールバック全走査（`workflowRoleMap.ts:50` の `findInput(["pixels","image"])`）が id 昇順で最初に `image` 入力を持つ 752 にヒットするため。このまま img2img モード（親あり）で使うと `patchImg2ImgLatentPath` / `patchInpaintLatentPath` が 752 を VAEEncode と誤認して conditioning 配線を破壊する（`workflowInpaint.ts:35-37, 130-132`）。**対策は「§5 img2img モードとの組合せ」参照**

## 全体パイプライン

```
[クライアント]
親画像 → pose worker (MediaPipe) → 33 landmarks
      → OpenPose 18点へ変換 → PoseDraft（関節ドラッグ編集）
      → スケルトン PNG 描画（黒背景・OpenPose 配色）
      → request.controlnet.poseImageDataUrl として POST /api/projects/:id/rounds
[サーバ]
decode/検証 → storeControlImage（ローカル保存） → uploadImageToComfy（POST /upload/image）
      → patchControlNetPath（LoadImage 差替え + strength/start/end 注入） → queuePrompt
```

inpaint 添付（`request.inpaint`: dataURL → `storeMaskImage` → `/upload/image` → `patchInpaintLatentPath`）と同型の「添付パターン」を複製する。

## 1. モデル配布（GitHub Release + サーバ proxy）

現状の WebSAM パターン（調査済み）:

- レジストリ: `src/client/websam/models.ts:5-19`（SlimSAM-77 encoder/decoder ONNX、計 ~13MB）
- 既定 base URL `/api/websam-models`（`src/shared/constants.ts:1`）→ サーバ proxy `serveWebSamReleaseAsset`（`src/server/index.ts:199-244`）が GitHub Release `websam-models-v1`（private repo、`GURUGURU_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` 必須）から asset をストリーム
- ファイル名 allowlist: `src/server/index.ts:24` `webSamReleaseAssetNames`
- クライアントキャッシュは **OPFS**（`websam/worker.ts:607-640`、`CACHE_DIR="guruguru-websam-models"`）

ポーズモデルの追加:

- `pose_landmarker_full.task`（float16、約 9MB）を GitHub Release の asset として追加。**推奨: 新タグ `pose-models-v1`** を切り、proxy を「filename → release API URL」の小さなレジストリ方式に一般化する（`webSamReleaseAssetNames: Set<string>` → `Map<string, string>`）。代替: 既存 `websam-models-v1` release に同居させれば allowlist 1 行追加で済む（タグ名の意味は濁る）
- `src/shared/constants.ts` に pose 用 release URL 定数を追加
- モデル元: MediaPipe 公式配布の `pose_landmarker_full.task`（Google storage から取得して release へミラー）

## 2. クライアントランタイム（@mediapipe/tasks-vision）

- 依存追加: `@mediapipe/tasks-vision`（現状 dependencies は `mermaid` と `onnxruntime-web` のみ。`package.json:17-20`）
- **wasm assets 配信**: tasks-vision は独自 wasm ランタイムを要求する。`scripts/build.mjs:57-72` の `copyOrtRuntimeAssets`（→ `dist/public/ort/`）と同型の `copyMediapipeWasmAssets` を追加し、`node_modules/@mediapipe/tasks-vision/wasm/*` を `dist/public/mediapipe-wasm/` へコピー。クライアントは `FilesetResolver.forVisionTasks("/mediapipe-wasm")` で解決
- **専用 worker**: `src/client/pose/worker.ts` を新設し、`scripts/build.mjs:42-50` の websam worker と同様に `/pose-worker.js` へ単独 bundle。メッセージプロトコルは `src/client/websam/types.ts` の `progress` / `model-ready` / `error` 型を踏襲した `PoseWorkerRequest`/`PoseWorkerResponse`（`load-model` / `detect`(RGBA raw pixels) / `destroy`）
- **OPFS キャッシュ**: `readCachedModelFile` / `writeCachedModelFile` / `fetchWithProgress`（`websam/worker.ts:544-640`）のパターンを流用。キャッシュディレクトリは別名 `guruguru-pose-models`。OPFS から得た ArrayBuffer は `Uint8Array` にラップして渡す（`modelAssetBuffer` は ArrayBuffer 不可。第 1 引数の WasmFileset も必須）:

  ```ts
  const vision = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetBuffer: new Uint8Array(buffer) },
    runningMode: "IMAGE",
    numPoses: 1,
  });
  ```
- delegate は `"GPU"` を先に試し失敗で `"CPU"`（websam の webgpu→wasm fallback `worker.ts:153-175` と同型）
- 進捗 UI: `webSamDownloadProgress` / `.websam-progress` プログレスバー（`assetModal.ts:181-186`、`main.ts:2695-2715` の日本語ステータス文言）と同じ見た目・状態遷移（`WebSamModelStatus` union `types.ts:5-15` を流用）

## 3. ポーズデータモデルと OpenPose 変換

### PoseDraft（新規 `src/client/poseTypes.ts` + `src/client/poseDraft.ts`）

```ts
interface PosePoint { x: number; y: number; /* 画像 natural px */ visible: boolean; }
interface PoseDraft {
  enabled: boolean;                 // 次回生成に添付するか（InpaintDraft.enabled と同義）
  points: PosePoint[] | null;       // OpenPose 18点（編集対象。null = 未検出）
  source: "detected" | "edited";
  strength: number;                 // 既定 1.0（0〜2）
  startPercent: number;             // 既定 0
  endPercent: number;               // 既定 1
  modelStatus: ...;                 // WebSamModelStatus 相当
}
```

- 保持: `state.poseDrafts: Record<assetId, PoseDraft>`（`state.inpaintDrafts` `main.ts:161` と同型、in-memory）
- **編集対象は OpenPose 18 点**（表示スケルトン = 編集対象で一致させる）。MediaPipe 33 landmarks は検出直後に 18 点へ変換して破棄

### MediaPipe 33 → OpenPose(COCO 18) マッピング

| OpenPose | MediaPipe index | 備考 |
| --- | --- | --- |
| 0 nose | 0 | |
| 1 neck | (11+12)/2 | 両肩の中点で合成。編集時は独立点 |
| 2/5 R/L shoulder | 12 / 11 | |
| 3/6 R/L elbow | 14 / 13 | |
| 4/7 R/L wrist | 16 / 15 | |
| 8/11 R/L hip | 24 / 23 | |
| 9/12 R/L knee | 26 / 25 | |
| 10/13 R/L ankle | 28 / 27 | |
| 14/15 R/L eye | 5 / 2 | |
| 16/17 R/L ear | 8 / 7 | |

- `visibility < 0.5` の landmark は `visible: false`（描画対象外、UI では半透明ハンドル表示でトグル可能に）
- 座標は normalized → 画像 natural px に変換して保持

### スケルトン PNG 描画（`renderPoseSkeletonDataUrl`）

- 黒不透明背景の canvas（画像 natural size）に OpenPose 標準配色で bone（線分）と関節（円）を描画 → `toDataURL("image/png")`
- bone 接続と色は OpenPose/ControlNet 学習時の標準（COCO 18: 首→肩=赤系、腕=橙〜黄、脚=緑〜青、顔=紫系のグラデーション 17 色）をそのまま使う。線幅は `max(4, round(min(w,h)/128))` 程度、関節円は線幅と同径
- pure helper として `src/client/poseSkeleton.ts` に置き、bone 表・色表込みでユニットテスト可能にする（fake canvas でノード列の検証、または座標計算部分だけ pure 化）

## 4. タブ UI と関節編集

### タブ

- 場所: マスク編集レイアウト右サイドバー `renderSmartMaskSidebar`（`assetModal.ts:309-318`）のパネルヘッダー「スマート選択」右（スクリーンショット赤枠）
- 実装: アプリ唯一のタブパターン `.mask-panel-tabs` / `.mask-tab`（`assetModal.ts:261-265`、`styles.css:2081-2109`）を再利用。`state.maskPanelTab: "mask" | "pose"` を新設し、`data-action="set-mask-panel-tab"` → state 更新 → `render()` で `.active` 付与
- タブは右パネルの内容と**中央プレビューの操作モード**を同時に切り替える: mask タブ = 従来のマスクストローク/SAM プロンプト、pose タブ = 関節ドラッグ（マスクの pointer ハンドラは pose タブ中は発火させない）
- pose タブの内容: モデルカード（DL 進捗）/「ポーズ検出」ボタン / 添付 ON/OFF トグル / strength・start・end スライダー（`renderRangeControl` `generationPanel.ts:265-282` 再利用）/ リセット（再検出）

### 関節ドラッグ編集

- 中央プレビューに SVG オーバーレイ（`renderWebSamPromptOverlay` `assetModal.ts:128-146` と同型の `renderPoseOverlay`）: bone 線分 + 関節ハンドル circle（r≈6、ホバーで強調）
- ジェスチャは module スコープの `activePoseJointDrag`（`activeBoxPrompt` `main.ts:126` と同型）。pointerdown で最近傍関節（閾値内）を掴み、**ドラッグ中は SVG 属性を直接更新**（`render()` を呼ばない。`updateMaskBrushCursor` `main.ts:1757-1787` の前例）、pointerup で draft コミット + `render()`
- 座標変換は `pointerToMaskCanvasPoint`（`maskCanvas.ts:146-154`）を流用（zoom/pan は getBoundingClientRect 経由で自動吸収）
- 関節クリック（ドラッグなし）で visible トグル（オクルージョン対応）

## 5. 生成リクエストとサーバ側

### 型（`src/shared/types.ts`）

```ts
export interface ControlNetOptions {
  poseImageDataUrl: string | null;  // クライアント→サーバ。保存後 null 化
  poseImagePath?: string | null;    // サーバ内部
  strength: number;
  startPercent: number;
  endPercent: number;
}
// GenerationRequest に追加: controlnet?: ControlNetOptions | null;  (inpaint と同列, types.ts:70 付近)
```

### クライアント送信

- `controlnetRequestForParent(parentAssetId)`（`inpaintRequestForParent` `main.ts:3030-3044` と同型）: `hasActivePoseData(draft)`（enabled && points 有り）のとき、送信時に `renderPoseSkeletonDataUrl` で PNG 化して添付
- **generationMode は img2img に限定しない**。テンプレートが ControlNet を含むかで添付可否を決める（下記 capability 判定）。ただし img2img との組合せには前提修正が必要（後述「img2img モードとの組合せ」参照。初期リリースは txt2img 系テンプレート限定）。参照ワークフローは t2i 構成（denoise=1 が自然）なので、既存の generationMode `"controlnet"`（`defaultDenoiseForMode`=0.45、`generationMode.ts:7-12`）の値は今回触らない
- capability 判定: テンプレートの workflowJson に `ControlNetApplyAdvanced` が存在するか（クライアントは template.workflowJson を保持済み）。無いテンプレートでは pose タブに「このテンプレートは ControlNet 未対応」を表示し添付しない

### サーバ処理（`src/server/rounds.ts` ほか）

1. `prepareControlNetRequest`（`prepareInpaintRequest` `rounds.ts:219-275` と同型）: `decodeMaskDataUrl` 相当の PNG 限定 decode（8MB 上限。`uploadDataUrl.ts` に `decodeControlImageDataUrl` を追加、実体は共通化）→ 寸法読み取り（親画像と同寸で描くため通常一致するが、ControlNet 入力は ComfyUI 側で latent 寸法へリサイズされるため**厳密一致は要求しない**）
2. `storeControlImage`（`storage.ts` に `storeMaskImage` `storage.ts:61-79` と同型追加）: `{dataRoot}/projects/{projectId}/control/{roundId}_pose.png`（dataRoot は `GURUGURU_DATA_DIR` 配下 = リポジトリ外。`ensureProjectStorage`（`storage.ts:21-37`）の作成ディレクトリ一覧に `control` を追加する）
3. `uploadImageToComfy(poseImagePath)`（`comfy.ts:155-183`、`POST /upload/image`）→ `PatchContext`（`workflow.ts:8-15`）に `uploadedControlImageName` を追加
4. `request_json` 保存前に `poseImageDataUrl` を null 化（inpaint の `maskDataUrl` null 化 `rounds.ts:288` と同じ。巨大 dataURL を DB に入れない規約 = 操作メモ.md:48）

### ワークフローパッチ（新規 `src/server/workflowControlNet.ts`）

`patchControlNetPath(workflow, roleMap, uploadedControlImageName, request)`:

1. apply ノード特定: `roleMap.controlnet_apply_node` → 無ければ `findNodeIdByExactClass(workflow, "ControlNetApplyAdvanced")`（`workflowGraph.ts:110-120`）。無ければ何もしない（optional 添付）
2. `inputs.image` の connection（`isConnection` `workflowGraph.ts:158-160`）を辿って control image 供給ノードを特定。`LoadImage` ならその `inputs.image` に `uploadedControlImageName` を注入。`LoadImage` でなければ `nextNodeId` で `LoadImage` を追加して `inputs.image` へ差し替え
3. `strength` / `start_percent` / `end_percent` を request 値で上書き
4. `ControlNetLoader.control_net_name` には**触れない**（決定事項）

新 role（roleMap 拡張。手書き優先、無ければ上記トレースで自動特定）:

- `controlnet_apply_node` / `controlnet_strength_input` / `controlnet_start_percent_input` / `controlnet_end_percent_input`
- `inferRoleMap`（`workflowRoleMap.ts:10-58`）に `ControlNetApplyAdvanced` トレースを追加（`findInput(["image"], ["LoadImage"])` の単純検索は inpaint 用 LoadImage と衝突するため使わない）

### 既存の一括注入との分離（挙動変更・要 characterization 更新）

`patchWorkflow`（`workflow.ts:61-67`）は `uploadedImageName`（親画像）を **6 role** に一括注入する: `setRolePath` で `load_image_input` / `ipadapter_image_input` / `controlnet_image_input`（62-64 行）、`setNodeInput` で `load_image_node` / `ipadapter_image_node` / `controlnet_image_node`（65-67 行）。pose 添付時の親画像 clobber を防ぐには次の 2 点が必要:

1. **`request.controlnet` があるときは `controlnet_image_input` と `controlnet_image_node` の両方**への親画像注入をスキップする分岐
2. **実行順序の規定**: `patchControlNetPath` は `patchWorkflow` の親画像注入（61-67 行）より**後**に実行する。`patchInpaintLatentPath` と同じく `patchWorkflow` 本体の末尾から呼ぶ位置づけにする。これにより、`load_image_input` が 754（control 用 LoadImage）に推論されているテンプレートで親画像が先に 754 へ書き込まれても、`patchControlNetPath` が pose 画像で上書きして勝つ（順序だけに依存させず、`load_image_input` の解決先ノードが `ControlNetApplyAdvanced.inputs.image` の接続先と一致する場合は load 系注入もスキップする防御を入れるのが望ましい）

`src/server/workflow.test.ts` の characterization を先に追記してから変更する（第15フェーズの確立パターン）。テストケースに「controlnet 添付あり + load_image_input が control 用 LoadImage を指すテンプレート」を必ず含める。

また `inferRoleMap` が参照ワークフローの `load_image_input` を 754（control 用 LoadImage）に推論する点: t2i テンプレとして使う限り `uploadedImageName` は null（親なし）なので実害はなく、controlnet モード（親あり）で pose 添付なしだと親画像が 754 に入る = 「親画像を直接 control image にする」現行挙動になる。これは既存機能として維持する。

### img2img モードとの組合せ（vae_encode_image_input 誤推論への対処）

参照ワークフローでは `vae_encode_image_input` が 752（`ControlNetApplyAdvanced`）の `inputs.image` に誤推論される（§参照ワークフロー参照）。このため **ControlNet テンプレート × img2img モードは対処なしでは成立しない**（`patchImg2ImgLatentPath` / `patchInpaintLatentPath` が 752 を VAEEncode と誤認して conditioning 配線を破壊する）。対処方針:

- `inferRoleMap` の `vae_encode_image_input` フォールバック（`workflowRoleMap.ts:50`）から `ControlNetApplyAdvanced` / `LoadImage`（control 供給側）を除外する修正を入れる（VAEEncode 系 class に限定するのが安全）
- 初期リリースでは pose 添付の動作保証対象を **txt2img 系テンプレート（参照ワークフロー構成）に限定**し、img2img との組合せは上記 inferRoleMap 修正 + characterization test を済ませてから解禁する
- この誤推論ケース（VAEEncode 不在ワークフローでの roleMap 推論）自体を characterization test の対象に含める

## 6. グリッドバッジ（棒人間）

- `src/client/icons.ts` に `iconPose()` を追加（既存同様 `viewBox="0 0 24 24"` の stroke SVG。頭 circle + 胴・四肢 path の棒人間）
- `renderAssetTile`（`galleryView.ts:128-157`）: `masked` と並べて `posed = poseDraftHasAttachment(getPoseDraft(asset.id))` を判定（`getInpaintDraft` と同様に `renderProjectDetail` 経由で getter 注入）。`line 153` の mask-badge の隣に `pose-badge` を出力
- CSS: `.mask-badge`（`styles.css:1396-1420`）と同型の `.pose-badge` を追加。位置は mask-badge（right:8px / bottom:44px）の上 `bottom:76px` 付近
- セマンティクス: MASK バッジと同じ「**次回生成に添付される**」draft 駆動（操作メモ.md:50-51 と整合）。`state.showMaskGridTag` のタグ表示トグルに追従させるかは実装時に判断（推奨: 同じトグルに乗せる）

## 実装フェーズ（ブランチ: `feature/pose-N-<slug>`）

1. **配布基盤**: release タグ作成 + `.task` asset アップロード、proxy 一般化 + allowlist + constants。検証: `curl --max-time 5` でモデル取得
2. **pose worker**: `@mediapipe/tasks-vision` 導入、build.mjs（wasm コピー + worker bundle）、OPFS キャッシュ、`load-model`/`detect` プロトコル。検証: 単体ページ or console から detect 結果確認
3. **PoseDraft + タブ UI + 検出**（編集なし・表示のみ）: タブ切替、モデルカード、検出 → 18 点変換 → SVG 表示
4. **関節ドラッグ編集** + visible トグル + スケルトン PNG 描画（`poseSkeleton.ts` + ユニットテスト）
5. **サーバ添付パイプライン**: `ControlNetOptions` / prepare / store / upload / `patchControlNetPath` / 一括注入分岐。**characterization test 先行**（`workflow.test.ts` に現行挙動固定 → 追加）
6. **バッジ + 仕上げ**: `iconPose` / `.pose-badge` / 操作メモ.md 追記

各フェーズで: `npm run typecheck` / `npm test` / `$env:GURUGURU_TEST_DB='1'; npm run check` / `git diff --check`、UI フェーズは 1680x920 viewport で確認、テスト起動は非 5177 ポート + `GURUGURU_TEST_DB=1`。

## 変えないこと

- 既存 inpaint パイプライン（マスク合成式・red channel・`patchInpaintLatentPath` の配線）
- 既存 roleMap キーの意味・`ControlNetLoader` のモデル名・WebSAM の挙動
- UI 文言・`data-action`・API path・response shape・DB 保存形式（`request_json` への追加フィールドのみ）

## 未決事項

- release タグを新設（`pose-models-v1` + proxy 一般化、推奨）か `websam-models-v1` 同居（変更最小）か
- 複数人ポーズ（`numPoses > 1`）・ゼロからの手動配置は将来スコープ（今回は 1 人・検出起点のみ）
- pose 添付なしで ControlNet テンプレートを txt2img 実行した場合、754 の残骸ファイル名が残り ComfyUI 側で missing file エラーになり得る。テンプレート登録時の正規化 or 実行前警告のどちらで防ぐか
- `asset_parents.strength` は現在 denoise 転用（`rounds.ts:551-563`）。ControlNet strength の記録は `request_json` 内で足りる想定だが、関係テーブルに出すかは実装時判断

## 変更履歴

- 2026-07-02: 起票。コードベース調査 + ユーザー確認事項を反映した初版。
