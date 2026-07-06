# モデル選択(Chroma)+ 必要モデルインストール案内モーダル / テンプレート登録UI削除

## 現状(調査結果)

GURUGURU の生成は統合 Switch ワークフロー(Chroma 構成)テンプレートを使うが、必要モデルの ComfyUI 側への手動配置が前提で、アプリは「どのモデルが必要か・どこに置くか・実際に在るか」を提示しない。長期方針(ユーザー確認済み)は「任意 workflow インポートの完全廃止 → アプリ側が対応テンプレートと必要モデルを提示する方式」。

今回のスコープ(ユーザー指示で確定):

1. 既存のテンプレート登録UI(「テンプレート登録」ボタン + インポートモーダル)を削除
2. その場所に「モデル選択」項を新設し「Chroma」ボタンを置く
3. クリックで「必要モデルインストール」モーダルを開き、必要モデル一覧・ComfyUI 配置先・存在確認(✓/✗/未確認)を表示
4. テンプレートの DB 登録手段は今回は設けない(既存 DB の登録済みテンプレートを使い続ける。自動登録=内蔵テンプレート化は後続フィーチャー)
5. Chroma のみ対応(モデルファミリ抽象化はしない)

### 必要モデル(参照ワークフロー `Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json` で確認済み)

| ノード | class_type | 入力 | モデルファイル | 配置先 |
|---|---|---|---|---|
| 731 | UNETLoader | unet_name | Chroma1-HD-fp8mixed.safetensors | models/diffusion_models |
| 733 | CLIPLoader (type=chroma) | clip_name | t5xxl_fp8_e4m3fn_scaled.safetensors | models/text_encoders |
| 710 | VAELoader | vae_name | ae.safetensors | models/vae |
| 753 | ControlNetLoader | control_net_name | diffusion_pytorch_model.safetensors | models/controlnet |

加えてコアノード `ComfySwitchNode` / `PrimitiveBoolean` が必須(comfy_extras 由来、カスタムノード不要)。

## 設計

### 1. モデル抽出の共有モジュール — 新規 `src/shared/workflowModels.ts`

既存 `modelDefaultsFromWorkflow`(`src/client/workflowDefaults.ts:52`)の入力名ベース走査(`ckpt_name`/`unet_name`/`clip_name*`/`vae_name`/`lora_name`)を参考にサーバーから使える抽出関数を新設し、未対応の `control_net_name`(controlnet)を追加。`src/shared/json.ts` の `isJsonObject` を利用。

```ts
export type ModelKind = "checkpoint" | "diffusionModel" | "textEncoder" | "vae" | "controlnet" | "lora";
export interface WorkflowModelRequirement {
  kind: ModelKind;
  name: string;        // "Chroma1-HD-fp8mixed.safetensors"
  loaderClass: string; // "UNETLoader" (/object_info 照合キー)
  inputName: string;   // "unet_name" (choices 取り出しキー)
}
export function extractModelRequirements(workflow: Json): WorkflowModelRequirement[];
export const MODEL_TARGET_DIRS: Record<ModelKind, string>; // "models/diffusion_models" 等の配置先案内
```

既存の `modelDefaultsFromWorkflow` / 生成パネルのモデル欄は今回触らない。

### 2. サーバー API — `GET /api/comfy/model-check?family=chroma`

- モデルの出所はアプリ同梱の参照 JSON(`Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json`)。パス解決は `src/server/workflowUnifiedSwitch.test.ts:18` と同じ `new URL("../../Docs/...", import.meta.url)` パターン。DB テンプレートではなく参照 JSON を単一ソースにする(「アプリ側から必要モデルを提示する」方向に一致。将来のテンプレート内蔵化でもそのまま使える)
- 新規 `src/server/modelCheck.ts`。pure 部 `matchRequirements(requirements, choicesByLoaderClass)` と IO 部を分離(pure 部を単体テスト)
  1. 参照 JSON 読み込み → `extractModelRequirements`
  2. `/object_info/{class}` per-class エンドポイントで照合(全量 `/object_info` は数 MB)。対象 class = loaderClass distinct + `ComfySwitchNode` + `PrimitiveBoolean`。`Promise.all` 並列。存在しない class は `{}` が返る = ノード存在チェックを兼ねる
  3. choices は `objectInfo[class].input.required[inputName][0]`(required→optional の順で探索)
  4. 一致判定は完全一致 or basename 一致(ComfyUI はサブフォルダ配置を `sub/ae.safetensors` 形式で列挙。`/` `\` 両対応)
  5. ComfyUI 未接続でも 200 で返し `comfy.ok=false`・`available: null`(「モデルを置いてから ComfyUI を起動する」段階でも一覧+配置先案内を出すのが主目的)
- `src/server/comfy.ts` に `fetchComfyNodeInfo(classType)` を追加(module-private `comfyFetchJson` の薄い wrapper)
- 共有型を `src/shared/apiTypes.ts` へ: `ModelCheckEntry {kind,name,loaderClass,inputName,targetDir,available: boolean|null}` / `ModelCheckResult {family, comfy:{ok,baseUrl,error?}, nodes:[{classType,available}], models, checkedAt}`
- ルートは `src/server/index.ts:118` の `GET /api/comfy/status` 直後、`url.searchParams.get("family")` で受ける(chroma 以外は 404)

### 3. クライアント — モデル選択項 + 必要モデルインストールモーダル

- モデル選択項: `homeView.ts:61` の `renderWorkflowImportPanel()` を「モデル選択」セクションに置き換え。「Chroma」ボタン(`data-action="open-model-install" data-family="chroma"`)を配置
- モーダル: `workflowUi.ts` に `renderModelInstallModal(family, check)` を新設。既存 `renderWorkflowImportModal` と同じ `.workflow-modal` / `.workflow-dialog` 構造。内容:
  - ComfyUI 接続状態(`comfy.ok` / baseUrl / エラー)
  - `nodes` に false があれば「必須ノード ComfySwitchNode / PrimitiveBoolean が見つかりません(ComfyUI のバージョン確認)」警告
  - モデル表: 種別 / ファイル名 / 配置先(`ComfyUI/models/xxx`)/ 状態バッジ ✓(緑)・✗(赤)・未確認(灰)
  - フッター: 「再チェック」(`data-action="recheck-models"`)+「閉じる」(`data-action="close-model-install"`)
  - main.ts のモーダル描画箇所(`main.ts:592`)から呼ぶ
- 新規 `src/client/modelCheckController.ts`(AGENTS.md 規約: 専用 controller + `registerActions`、main.ts へ関数追加禁止):
  - `appState.ts` に `modelInstallFamily: "chroma" | null`(null=閉)と `modelCheck: {status: "idle"|"loading"|"ready"|"error", result: ModelCheckResult|null}` を追加
  - `refreshModelCheck(family)` — `settingsController.ts` の `refreshComfyStatus()` と同じ「`api<T>()` → state 更新 → `requestRender()`」パターン。in-flight 重複フェッチ防止
  - actions: `open-model-install`(family セット + `void refreshModelCheck`)/ `close-model-install` / `recheck-models`
- CSS: `.workflow-dialog` 系に倣いモーダル表・バッジ用クラス(`.model-check-ok` / `.model-check-missing` / `.model-check-unknown`)を追加

### 4. テンプレート登録UIの削除

削除:
- `workflowUi.ts`: `renderWorkflowImportModal` / `renderWorkflowImportPreview`、`renderWorkflowImportPanel` は「モデル選択」へ置き換え
- `main.ts:592` の import モーダル描画(モデルインストールモーダルに差し替え)
- `appState.ts`: `workflowImportModalOpen` / `workflowImportDraft` と `defaultWorkflowImportDraft` import
- `projectController.ts`: `openWorkflowImportModal` / `closeWorkflowImportModal` / クライアント側 `createTemplate` / `captureWorkflowImportDraft(FromElement)` / `refreshWorkflowImportPreview` / `parseWorkflowFileContent` を使う file 読み込みハンドラ / 各所の `state.workflowImportModalOpen = false` リセット / actions `"open-template-import"` `"close-template-import"` `"create-template"`
- `workflowImport.ts`: `defaultWorkflowImportRoleMap` / `defaultWorkflowImportDraft` / `parseWorkflowFileContent` / `WorkflowFileImport` / `WorkflowFileParseResult`。`slugify` / `workflowExportFilename` / `buildTemplateExportPayload` は export 機能が使うため残す
- `workflowImport.test.ts`: 削除する関数のテストを除去(export 系テストは残す)
- `workflowTypes.ts` の `WorkflowImportDraft` 型(他に参照が無ければ)
- 明らかに死ぬ CSS セレクタ(`.workflow-import-*` のうちモーダル専用のもの)

残す(今回触らない):
- サーバー `POST /api/templates`(`templates.ts` の `createTemplate`)— UI 呼び出し元は消えるが、テストと後続の内蔵テンプレート seed で再利用するため温存
- テンプレート一覧の diagram / export / 削除ボタン(`renderTemplatePanel`)
- `shared/workflowRoleMap.ts`(サーバー `createTemplate` が `validateRoleMapReferences` を使用)

## 実装フェーズ

作業は git worktree(メインチェックアウトは main のまま): `git worktree add ../guruguru-wt-model-select -b feature/model-select` → 完了後 main へマージ。

- Phase 0: 本ドキュメント起票 + 操作メモ.md 変更履歴に1行
- Phase 1 — 共有抽出: `src/shared/workflowModels.ts` + テスト。`npm test` / `npm run typecheck`
- Phase 2 — サーバー API: `comfy.ts` / `modelCheck.ts` / `apiTypes.ts` / `index.ts` ルート。`modelCheck.test.ts` は pure 部のみ。`npm test` / `npm run check`
- Phase 3 — クライアント新 UI: モデル選択項 / モーダル / `modelCheckController.ts` / appState / CSS。`npm run check` + ブラウザ確認
- Phase 4 — 登録UI削除: 上記削除一覧を実施。`npm test` / `npm run typecheck` / `npm run check` 全通し
- Phase 5 — 実機検証・マージ: 実機検証 → 本ドキュメント仕上げ → main へマージ、`Docs/Done/` へ移動

## 変えないこと

- `patchWorkflow` / roleMap / 動的パッチ生成経路(削除は後続フィーチャー)
- サーバーのテンプレート API(POST /api/templates 含む)・テンプレート一覧の diagram/export/削除 UI
- 生成パネルのモデル欄(`modelDefaultsFromWorkflow` / `renderModelReadout`)
- DB スキーマ

## 検証

- 単体: `npm test` / `npm run typecheck` / `npm run check`
- API 単体: テスト起動(PORT≠5177・`GURUGURU_TEST_DB=1`)で `curl "http://127.0.0.1:<port>/api/comfy/model-check?family=chroma"`(ComfyUI 停止時も 200 + available:null になること)
- 実機: テスト用 ComfyUI(port 8288、操作メモ.md の手順)で
  1. ホームの「モデル選択」に Chroma ボタンが出る/テンプレート登録ボタンが消えている
  2. Chroma クリック → モーダルに4モデル+配置先が並び、モデル配置済みなら全行 ✓
  3. ComfyUI 停止状態で「未確認」+配置先案内が表示される(再チェックで復帰)
  4. ComfySwitchNode / PrimitiveBoolean チェックが ✓
  5. 既存機能の回帰: テンプレート選択・生成・export・diagram が従来どおり動く
  - 本番 8188 の /history・/view は読まない

## 今後の方向(今回スコープ外)

Chroma テンプレートの内蔵化(起動時 seed / バージョン更新)、roleMap+動的パッチ経路(workflow.ts legacy 分岐 / workflowInpaint.ts / workflowControlNet.ts / workflowRoleMap.ts / sanitizeRoleMap)の削除、モデルファミリ追加(モデル選択項はボタンを足すだけで拡張できる構造にしておく)。

## 未決事項(実装中に判断)

- モデル一覧の出所を参照 JSON にしたため、DB 上のテンプレートが参照 JSON から改変されている場合は実使用モデルと表示がずれ得る(テンプレート内蔵化で解消する前提の割り切り)
