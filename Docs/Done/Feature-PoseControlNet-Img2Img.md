# img2img × ControlNet（pose 添付）併用対応

- ステータス: 実装済み
- 最終更新: 2026-07-03
- 関連: `Docs/Done/Feature-PoseControlNet.md`（§5「img2img モードとの組合せ」が指す制限は本対応で解消）

## 概要

img2img（分岐生成）/ inpaint と ControlNet（pose 添付）を併用可能にした。ブランチ `feature/pose-7-img2img-controlnet`。

これまで、VAEEncode ノードを持たない ControlNet テンプレート（参照ワークフロー `Docs/ReferenceFlows/ComfyUI_00147_controlnet.json` 構成）で img2img を実行すると、`inferRoleMap` の無条件フォールバック探索が `ControlNetApplyAdvanced.inputs.image` を `vae_encode_image_input` と誤推論し、`patchImg2ImgLatentPath` / `patchInpaintLatentPath` がそのノードを VAEEncode と誤認して conditioning 配線を破壊、ComfyUI `/prompt` が 400（`CFGGuider` の positive/negative 欠落）で失敗していた。コミット `44eee35` はこの症状をクライアント/サーバのガードで隠蔽していただけで、根本原因は未解決だった。

## 変更点

### 1. `inferRoleMap` の誤推論修正（`src/shared/workflowRoleMap.ts`）

- `vae_encode_image_input`: 無条件フォールバック（VAEEncode が無い場合に全ノード走査してしまう挙動）を廃止。classType に `VAEEncode` を含むノードのみを対象にする。該当ノードが無ければ role 自体を推論しない
- `load_image_input`: `ControlNetApplyAdvanced` が存在する場合、その `inputs.image` の接続先ノード（control 供給用 LoadImage）を探索対象から除外
- 新規推論 `controlnet_image_node`: apply ノードの `inputs.image` connection を辿り、LoadImage であればその id を記録する（generationMode `"controlnet"` の「親画像=control image」挙動が引き続きこの role 経由で成立する）

### 2. 生成時 roleMap サニタイズ（`sanitizeRoleMap`, `src/server/workflowGraph.ts`）

DB に保存済みのテンプレートは、修正前の `inferRoleMap` で推論された誤った roleMap を持ったままになる（再登録なしでは直らない）。`patchWorkflow`（`src/server/workflow.ts`）の冒頭で `sanitizeRoleMap(workflow, roleMap)` を適用し、生成時に防御する:

- `vae_encode_node` / `vae_encode_image_input` の参照先ノードの classType が `VAEEncode` を含まなければ、その role を破棄
- `load_image_node` / `load_image_input` の参照先が ControlNetApplyAdvanced の control 供給 LoadImage と一致する場合、その role を破棄し、`controlnet_image_node` が未設定ならそのノード id へ付け替える（親画像=control image 挙動の互換維持）

これにより既存テンプレートは再登録不要で正しく動作する。

### 3. LoadImage ノード衝突回避

- `patchImg2ImgLatentPath` / `patchInpaintLatentPath`（`src/server/workflowInpaint.ts`）の LoadImage フォールバック解決が `roleMap.controlnet_image_node` と同じノードに解決された場合、それを使わず `addLoadImageNode` で新規 LoadImage を追加する（親画像と control 画像がノードを共有しないようにする）
- `patchControlNetPath`（`src/server/workflowControlNet.ts`）: 辿り着いた LoadImage の `inputs.image` が既に親画像のアップロード名と一致する場合（＝親画像用として使われている場合）、上書きせず新規 LoadImage を追加する。判定用に親画像名（`context.uploadedImageName`）を新しい引数として渡すようにした

### 4. pose 未添付の img2img で strength=0（`src/server/workflow.ts`）

`patchWorkflow` で、ControlNetApplyAdvanced が存在し `request.controlnet` が null かつ `request.generationMode === "img2img"` のとき、`controlnet_strength_input` role とノードの `strength` を 0 に設定する。ComfyUI の `ControlNetApplyAdvanced` は strength==0 で conditioning をそのまま返す no-op になるため、pose 未添付の分岐生成は純粋な img2img として動作する。同時に、`controlnet_image_node` へ親画像が注入される（既存の一括注入ロジック）ため、control 用 LoadImage が stale なファイル名を参照して missing file エラーになることも防げる。

`generationMode === "controlnet"`（親画像を直接 control image にする既存機能）はこのルールの対象外で、テンプレート/リクエストの strength 値がそのまま使われる。

### 5. ガード撤去

- クライアント: `controlnetRequestForParent`（`src/client/main.ts`）の `generationMode === "img2img"` 早期 return を削除
- サーバ: `prepareControlNetRequest`（`src/server/rounds.ts`）の 400 スローを削除

## 解禁範囲

- img2img（分岐生成）× ControlNet pose 添付
- inpaint × ControlNet pose 添付（誤推論の根本原因・修正メカニズムが img2img と共通のため同時解禁）
- pose 未添付の img2img / inpaint も、strength=0 化により ControlNet テンプレートで従来通り動作する

## 変えないこと

- `ControlNetLoader.control_net_name`、既存 roleMap キーの意味、API path / response shape / DB スキーマ
- generationMode `"controlnet"` の親=control 挙動と `defaultDenoiseForMode`

## 未解決事項（スコープ外）

pose 未添付の **txt2img**（親画像が無いケース）では、control 用 LoadImage に旧いファイル名（stale filename）が残ったままになり得る。親画像が存在しないため注入しようがなく、strength=0 化も適用されない（img2img 限定のルールのため）。ComfyUI 側で missing file エラーになる可能性がある。この問題は本対応の前から存在する既知の未決事項であり、今回は対象外。
