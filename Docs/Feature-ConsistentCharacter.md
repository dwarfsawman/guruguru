# Feature: Consistent Character (Chroma) 機能取り込み

起票: 2026-07-07

## 現状(調査結果)

ユーザー提供の ComfyUI ワークフロー `Consistent Character Chroma.json` は、Chroma ベース生成に対して
**3つの任意機能ブランチ**を持つ:

- **ポーズ (ControlNet)** — ControlNet-Union + DWPose（GURUGURU は既にポーズ検出をクライアント側で実装済み）
- **顔スタイル参照 (PuLID-Flux)** — `ApplyPulidFlux` ＋ 専用ローダ3種（カスタムノード）
- **全体スタイル参照 (IP-Adapter)** — `ApplyAdvancedFluxIPAdapter` ＋ `LoadFluxIPAdapter`（カスタムノード）
- 補助: Hyper-Chroma 低ステップ LoRA、IP-Adapter 入力の背景除去 (RMBG)

### やりたいこと

1. このワークフローの機能を GURUGURU で再現する
2. モデルはユーザーが自分で ComfyUI に配置する（アプリはダウンロードしない）
3. **ユーザーが導入済みのモデルに応じて機能を自動 ON/OFF**（ControlNet モデルが無ければポーズだけ不可、
   IP-Adapter が無ければ IP-Adapter だけ不可、という具合。他の機能は動き続ける）
4. UI で参照画像を取り込み、**顔スタイル参照 (PuLID) と 全体スタイル参照 (IP-Adapter) を個別に有効化**できる

### 確定したスコープ（ユーザー回答）

- 参照画像 UI: 生成フォームの **親画像取り込みの下に「参照画像」枠を新設**。顔スタイル参照トグル／全体スタイル参照トグルを置く（フォームレベル・次回生成に適用）
- 顔用／スタイル用は **同じ 1 枚** を両方に使う
- スコープ: 主要3機能 (pose / PuLID / IP-Adapter) ＋ **Hyper-Chroma LoRA** ＋ **RMBG 背景除去**。
  siglip/unCLIP 追加条件付け・顔アップスケール(4xFaceUpDAT) は **対象外**
- ベースモデル: **現行テンプレートの Chroma (fp8 / コア UNETLoader) を維持**（元ワークフローの GGUF/MultiGPU には変更しない）

### 現状アーキテクチャ

- **フロント**: 素の TypeScript（フレームワーク無し）。文字列 HTML ＋ `domMorph`。状態は `src/client/appState.ts`
  シングルトン。per-asset オプションは `inpaintDrafts[assetId]` / `poseDrafts[assetId]` / `paintDrafts[assetId]`
  に持ち、カードの **バッジ**（`toggle-mask-attach` 等）でトグルする確立したパターンがある。
- **サーバ**: Node HTTP ＋ SQLite。ワークフローは DB テンプレート。パッチ経路は2系統:
  - レガシー動的パッチ（`workflow.ts` / `workflowInpaint.ts` / `workflowControlNet.ts`、roleMap 依存）
  - **統合 Switch 方式（現行の主経路）** `src/server/workflowUnifiedSwitch.ts`。静的テンプレート
    `Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json` に対し、`PrimitiveBoolean` の値書き換えだけで
    txt2img / img2img / inpaint / ControlNet有無 を切替。`resolveUnifiedSwitchRoles` が sampler から
    構造的にグラフを辿るため node id・title に依存しない。
- **生成フロー**: `src/server/rounds.ts` が親画像・マスク・ポーズ画像を ComfyUI `/upload/image` にアップロード →
  workflow をパッチ → `/prompt` に投入。`GenerationRequest`（`src/shared/types.ts`）が
  `inpaint` / `controlnet` / `pasteComposite` を運ぶ。ポーズはクライアントで OpenPose スケルトン PNG 化して
  `controlnet.poseImageDataUrl` として送る（サーバに DWPreprocessor は無い）。
- **モデルチェック**: `GET /api/comfy/model-check?family=chroma`（`src/server/modelCheck.ts`）。参照 JSON から
  必要モデルを抽出（`src/shared/workflowModels.ts` の `extractModelRequirements`、入力名
  `ckpt_name/unet_name/clip_name/vae_name/control_net_name/lora_name` を走査）し、
  `/object_info/{class}` を per-class で照会（**存在しない class は `{}` = カスタムノード存在チェックを兼ねる**）。
  結果を install モーダル（`src/client/workflowUi.ts` ＋ `modelCheckController.ts`）に表示。

## 中核となる制約（設計の土台）

**ComfyUI の prompt 検証は lazy 評価に関係なくグラフ全体を走査する**（`Reference-UnifiedSwitchWorkflow.md`
に実機検証済みと記載。未使用ブランチの LoadImage でもファイル名が実在しないと prompt 全体が拒否される
＝だからダミー画像をアップロードしている）。ここから2つの帰結:

- **カスタムノードが未導入**（PuLID / IP-Adapter）なら、そのノードがグラフに1つでも在ると prompt 全体が拒否される。
- **モデルファイルが未配置**なら、未使用ブランチのローダでも choices に無い値として検証エラーになる。

したがって **「導入済みモデルに応じた機能 ON/OFF」は Boolean スイッチだけでは実現できない**。任意機能
（および ControlNet モデル未配置時の ControlNet ブランチ）は、**ビルド時にグラフへ含めるか否かを条件分岐する**
必要がある。特に現状は ControlNet モデルがベーステンプレートにハードコードされているため、**今は事実上必須**
（CN モデルが無いと txt2img すら検証で落ちる）。これを本当に任意化するのも本改修の一部。

→ 採用方針: **フラグメント注入方式（fragment injection）**。コアの Switch テンプレートは静的なまま維持し、
PuLID / IP-Adapter / LoRA の自己完結サブグラフを、構造的に解決した挿入点へ「導入済み かつ 有効時のみ」
差し込む。ControlNet ブランチは「CN モデル未配置時に prune（枝刈り）」する。roleMap 推論は使わない
（過去のバグ源）ため、挿入点は `resolveUnifiedSwitchRoles` と同じく sampler/model チェーンから構造解決する。

**可用性 = 必要カスタムノードパックの存在 ∧ 必要モデルファイルの存在**。`/object_info/{class}` は未導入ノードに
対し `{}` を返すため、代表クラス名の照会でノードパック有無を検出できる（既に base で ComfySwitchNode/
PrimitiveBoolean を同方式でチェック済み）。

### 必要ノードパック（本スコープで確定）

| 機能 | 必要ノードパック | 代表クラス（存在検出用） | 必要モデルファイル（ユーザー配置） |
|---|---|---|---|
| ベース Chroma | 内蔵 comfy_extras のみ | `ComfySwitchNode` / `PrimitiveBoolean` | Chroma1-HD-fp8mixed / t5xxl_fp8 / ae.safetensors |
| ポーズ (ControlNet) | **不要（コアノード）** ※検出はアプリ側 | `ControlNetApplyAdvanced`（コア） | ControlNet モデル（Union系 .safetensors） |
| Hyper LoRA | **不要（コアノード）** | `LoraLoaderModelOnly`（コア） | Hyper-Chroma-low-step-LoRA.safetensors |
| 顔スタイル参照 (PuLID) | **PuLID-Flux (Chroma対応fork)** | `ApplyPulidFlux` / `PulidFluxModelLoader` | pulid_flux_v0.9.0.safetensors（EVA-CLIP/InsightFace は自動DL） |
| 全体スタイル参照 (IP-Adapter) | **x-flux-comfyui** | `LoadFluxIPAdapter` / `ApplyAdvancedFluxIPAdapter` | ip_adapter.safetensors / clip-vit-large-patch14.safetensors |
| RMBG 背景除去（任意上乗せ） | **comfyui-easy-use** | `easy imageRemBg` | RMBG-1.4（自動DL） |

ハード要件のカスタムノードパックは **x-flux-comfyui** と **PuLID-Flux(Chroma) パック** の2つのみ。RMBG を使う場合のみ
**comfyui-easy-use** が加わる。元ワークフローの他パック（essentials / ipadapter_plus_v2 / tinyterranodes /
multigpu / controlnet_aux / KJNodes / Advanced-Vision）は、アプリがポーズをクライアント側で行い・プロンプト/
サイズをコアノードへ直書きし・siglip/GGUF/upscale をスコープ外とするため**不要**。

※RMBG が未導入なら IP-Adapter は参照画像を直結して動作（背景除去は精度向上のオプション扱い）。
※PuLID は標準の ComfyUI-PuLID-Flux ではなく **Chroma 対応 fork** が必要な点に注意（Phase 1 で実機確認）。

## 設計

### 1. 機能タクソノミと MODEL チェーン挿入順

元ワークフローの MODEL チェーン順を踏襲する:

```
UNETLoader(731) → [Hyper LoRA] → [IP-Adapter apply] → [PuLID apply] → ModelSamplingAuraFlow(701) → CFGGuider/schedulers
```

挿入ロジック: 現在 `ModelSamplingAuraFlow(701).model` を供給しているノード（＝ `731`）を起点に、
`[lora, ipadapter, pulid]` のうち **導入済み かつ 有効** なフラグメントだけをこの順で連結し、最終出力を
`701.model` へ繋ぎ替える。各フラグメントは `model_in`（前段 MODEL）と `model_out` を持つ。

- **IP-Adapter フラグメント**: `LoadFluxIPAdapter`（ip_adapter.safetensors ＋ clip-vit-large-patch14.safetensors）
  ＋ `ApplyAdvancedFluxIPAdapter`（model / ip_adapter_flux / image）。image は参照画像。RMBG が導入済みなら
  `easy imageRemBg`（RMBG-1.4）を LoadImage(参照) と apply.image の間に挟む。未導入なら参照画像を直結。
- **PuLID フラグメント**: `PulidFluxModelLoader`（pulid_flux_v0.9.0.safetensors）＋ `PulidFluxEvaClipLoader`
  ＋ `PulidFluxInsightFaceLoader` ＋ `ApplyPulidFlux`（model / pulid_flux / eva_clip / face_analysis / image）。
  EvaClip・InsightFace は自動 DL のため存在チェックはノード存在のみ。
- **LoRA フラグメント**: `LoraLoaderModelOnly`（Hyper-Chroma-low-step-LoRA.safetensors）。コアノード。
  導入済みなら自動挿入（ユーザー回答「LoRA と書いてあったらロードでよい」）。

参照画像は 1 枚を PuLID の image と IP-Adapter の image（RMBG 経由）に共用する。

**フラグメントの node id 衝突回避**: フラグメントは独自の仮 id を持ち、注入時にベースの max id + オフセットへ
一括リナンバリングしてから配線する（小さなヘルパを用意）。

### 2. ControlNet ブランチの条件化

- CN モデルが **導入済み**: 現行どおり（`use-controlnet` Boolean をポーズ添付有無で切替。既存の
  `patchUnifiedSwitchWorkflow` の CN 経路・VAE 自動復元をそのまま使用）。
- CN モデルが **未配置**: **CN ブランチを prune**。`766`/`767`（positive/negative switch）を経由せず
  CFGGuider の positive/negative を `748`/`749`（CLIPTextEncode）へ直結し、`752/753/754/766/767/772` を削除。
  これで CN モデル名の未配置がグラフに残らず、txt2img/img2img/inpaint が動く。

### 3. サーバ: フラグメント注入と組み立て

- 新規 `src/server/workflowFeatureFragments.ts`:
  - フラグメント定義（API フォーマットの小さな JSON 断片。`Docs/ReferenceFlows/fragments/*.json` として同梱、
    または本モジュール内に定義）＋ `model_in`/`model_out`/`image_input`/`model_file_input` のメタ。
  - `assembleFeatureFragments(workflow, enabledFeatures, context)` — リナンバリング＋MODELチェーン連結＋
    画像名・モデル名・strength 書き込み。RMBG 有無で IP-Adapter の image 供給を切替。
  - `pruneControlNetBranch(workflow)` — CN 未配置時の枝刈り。
- `src/server/workflowUnifiedSwitch.ts`: `patchUnifiedSwitchWorkflow` の末尾で、機能可用性と request の
  トグルを見て `assembleFeatureFragments` / `pruneControlNetBranch` を呼ぶ。コア値パッチ（prompt/seed/dims/
  Boolean/ダミー画像）は現行のまま。
- `src/server/rounds.ts`:
  - **参照画像のアップロード**: `request.reference.imageDataUrl` を decode → `projects/<projectId>/reference/<roundId>.png`
    に保存（既存 `storeControlImage` 相当）→ `uploadImageToComfy` → context へ名前を渡す。
  - **機能可用性ゲート**: `modelCheck` のサーバ内ロジックを流用して導入済み機能集合を求め、
    request のトグルと AND を取って enabledFeatures を決定（未導入機能が要求されたら注入しないだけで no-op。
    UI 側でも無効化するので通常は到達しない）。
  - request_json へ保存する前に `reference.imageDataUrl` は null 化（mask/pose と同じ規約）。

### 4. モデルチェックの機能別拡張（ノードパック要件を含む）

- 単一ソース: 上表「必要ノードパック」を `workflowFeatureFragments.ts` にフラグメント定義と一体で持たせ、
  各 feature に `{ nodePacks: [{label, representativeClass}], models: [{kind, name, loaderClass, inputName, targetDir}] }`
  を宣言。
- `src/shared/workflowModels.ts`: カスタムローダの入力名→kind マッピングを追加（PuLID `pulid_file`、
  IP-Adapter の `ipadapter`/`clip_vision` 等。**正確な入力名・配置先はテスト用 ComfyUI(8288) の
  `/object_info` で確認して確定**）。各要件に `feature`（`base|controlnet|pulid|ipadapter|lora|rmbg`）を付与。
- `src/server/modelCheck.ts`:
  - 照会対象 class に各 feature の**代表ノードクラス**（`ApplyPulidFlux` / `LoadFluxIPAdapter` /
    `easy imageRemBg` など）を追加。`/object_info` が `{}` を返す = パック未導入。
  - feature 可用性 = **必要ノードパックの代表クラスが全存在 AND 必要モデルファイルが全存在**。
- `src/shared/apiTypes.ts`: レスポンスに `features` を追加。各 feature ごとに
  `{ available: boolean, missingNodePacks: [{label, representativeClass}], missingModels: ModelCheckEntry[] }`。
  ComfyUI 未接続時は既存どおり 200 ＋ `available: null`。
- install モーダル（`workflowUi.ts`）: **feature 見出しでグルーピング**し、各 feature に
  - 必要ノードパック行（✓ 導入済み / ✗ 未導入＋パック名・入手先ヒント）
  - 必要モデルファイル行（種別 / ファイル名 / 配置先 / ✓✗未確認）
  を並べる。「顔スタイル参照を使うには x-flux-comfyui と pulid_flux_v0.9.0.safetensors が必要」等が
  一目で分かる形にする。

### 5. フロント: 参照画像 UI ＋ 機能ゲート

- `src/client/views/generationPanel.ts`: **親画像セクションの直下に「参照画像」セクション**を新設。
  - 取り込み: file input ＋ ドラッグ/貼付（既存の source upload ＋ `pasteObjectController` のパターンを流用）。
  - サムネイルプレビュー＋クリアボタン。
  - トグル2つ: **顔スタイル参照 (PuLID)** / **全体スタイル参照 (IP-Adapter)**。
    対応機能が未導入なら **disabled ＋ ツールチップ**（「モデル未導入。モデル選択→Chroma で確認」）。
- 新規 `src/client/referenceController.ts`（AGENTS.md 規約: 専用 controller ＋ `registerActions`、
  main.ts へ関数追加しない）: 画像取り込み・トグル・クリアのアクション。
- `src/client/appState.ts`: `referenceDraft = { imageDataUrl, faceEnabled, styleEnabled }`（フォームレベル）と、
  `modelCheck.result.features` から導出する可用性フラグを追加。
- 永続化: `draftStore.ts` に `referenceDraft` を追加（localStorage、mask と同様の debounce）。per-round は
  `generationDraftsByRound` に含めるか別バケットにするかは実装時に既存 draft 構造へ合わせる。
- 送信: `GenerationRequest` に `reference` を載せる（`generationController.ts` / `generationDraft.ts`）。
- iteration ツリーのエッジポップアウトで参照画像を見せるなら、保存済み `reference/<roundId>.png` を
  `/api/rounds/:roundId/attachments/reference` で配信（既存 mask/pose 配信の登録方式に1行追加）。

### 6. リクエスト／型

- `src/shared/types.ts` の `GenerationRequest` に:
  ```ts
  reference?: {
    imageDataUrl?: string | null;   // 送信時のみ。保存前に null 化
    imagePath?: string | null;      // 保存後の参照
    face:  { enabled: boolean; weight?: number };   // PuLID
    style: { enabled: boolean; weight?: number };   // IP-Adapter
  } | null;
  ```

## 変更ファイル（要点）

**サーバ**
- 新規 `src/server/workflowFeatureFragments.ts` — フラグメント定義＋`assembleFeatureFragments`＋`pruneControlNetBranch`
- `src/server/workflowUnifiedSwitch.ts` — 注入/枝刈りの呼び出し接続
- `src/server/rounds.ts` — 参照画像アップロード・機能ゲート・request_json の null 化
- `src/server/modelCheck.ts` — `features` 集計、フラグメント要件の取り込み
- `src/server/index.ts` — 参照画像 attachments 配信ルート1件（既存 registry に追加）
- （任意）`Docs/ReferenceFlows/fragments/{ipadapter,pulid,lora}.json` — フラグメント同梱

**共有**
- `src/shared/workflowModels.ts` — カスタムローダ入力名／feature タグ追加
- `src/shared/apiTypes.ts` — `ModelCheckResult.features`
- `src/shared/types.ts` — `GenerationRequest.reference`

**フロント**
- `src/client/views/generationPanel.ts` — 参照画像セクション（親画像の下）
- 新規 `src/client/referenceController.ts` — 取り込み/トグル/クリア
- `src/client/appState.ts` — `referenceDraft` ＋ 可用性フラグ
- `src/client/generationController.ts` / `generationDraft.ts` — reference 送信
- `src/client/draftStore.ts` — 永続化
- `src/client/workflowUi.ts` — install モーダルの feature グルーピング＋ゲート説明
- CSS（参照画像枠・トグル・disabled 表示）

**再利用する既存資産**
- 構造解決: `resolveUnifiedSwitchRoles`（`workflowUnifiedSwitch.ts`）
- 画像添付パイプライン: `storeControlImage` / `uploadImageToComfy` / `ensureDummyComfyImage`（`rounds.ts`/`comfy.ts`）
- モデル照合: `matchRequirements` / `fetchComfyNodeInfo`（`modelCheck.ts`/`comfy.ts`）
- バッジ/トグル UI パターン、`registerActions` 規約、`draftStore` debounce

## 実装フェーズ（git worktree で作業。メインは main のまま。完了後 main へマージ）

- **Phase 0**: 本ドキュメント起票 ＋ `操作メモ.md` 変更履歴に1行。worktree
  `guruguru-wt-consistent-char`（ブランチ `feature/consistent-character`）を作成。
- **Phase 1 — フラグメント権威づけ（実機必須）**: テスト用 ComfyUI(8288) に PuLID / IP-Adapter / RMBG
  カスタムノード＋モデルを配置し、`/object_info` で各ノードの **正確な入力名・choices・配置先**を確定。
  フラグメント JSON／メタと `workflowModels.ts` のマッピングを実データに合わせて確定。
- **Phase 2 — モデルチェック拡張**: `workflowModels.ts` / `modelCheck.ts` / `apiTypes.ts` に `features`。
  pure 部の単体テスト。`npm test` / `npm run check`。
- **Phase 3 — サーバ組み立て**: `workflowFeatureFragments.ts`（注入＋CN prune）＋ `workflowUnifiedSwitch.ts`
  接続 ＋ `rounds.ts` 参照画像アップロード。フラグメント注入の単体テスト（有効な API グラフになる／
  CN prune で CN ノードが消える／MODEL チェーン順）。`npm test` / `npm run typecheck`。
- **Phase 4 — フロント**: 参照画像セクション（親画像の下）＋ `referenceController.ts` ＋ appState ＋ 送信 ＋
  install モーダル feature グルーピング ＋ 可用性による disabled。`npm run check` ＋ ブラウザ確認。
- **Phase 5 — 実機検証・マージ**: 下記「検証」を 8288 で実施 → ドキュメント仕上げ → main へマージ、
  `Docs/Done/` へ移動（push はユーザー依頼時のみ）。

## 変えないこと

- レガシー動的パッチ経路（`workflow.ts`/`workflowInpaint.ts`/`workflowControlNet.ts`、roleMap）
- ベースモデル(Chroma fp8 コア UNETLoader)
- モデルファミリ抽象化（chroma のみ）

## 検証

- **単体**: `npm test` / `npm run typecheck` / `npm run check`
  - フラグメント注入: 顔のみ／スタイルのみ／両方／無し で MODEL チェーンが期待順に組まれ、未有効機能の
    ノードが**含まれない**こと。CN prune で `ControlNetLoader/ControlNetApplyAdvanced` が消え positive/negative
    が CLIPTextEncode 直結になること。
  - model-check: 各 feature の `available` が「必要ノード全存在 AND 必要モデル全存在」で決まること。
    ComfyUI 未接続で `available: null`。
- **API**: テスト起動で `curl ".../api/comfy/model-check?family=chroma"` に `features` が並ぶこと。
- **実機（テスト用 ComfyUI 8288、操作メモ.md 手順。本番 8188 の /history・/view は読まない）**:
  1. PuLID/IP-Adapter/RMBG/CN のモデルを全部置く → 参照画像トグルが両方 enabled、install モーダル全 ✓
  2. 顔のみ ON → 生成が顔同一性を反映。スタイルのみ ON → スタイル反映。両方 ON → 両立。両方 OFF → 通常生成
  3. **IP-Adapter モデルだけ外す** → 全体スタイル参照トグルだけ disabled、他（顔・ポーズ・txt2img）は動く
  4. **ControlNet モデルだけ外す** → ポーズだけ不可、txt2img/img2img/PuLID/IP-Adapter は動く（CN prune 効果）
  5. Hyper LoRA 配置有無で自動挿入が切り替わる（少ステップ設定との整合を確認）
  6. 参照画像が `reference/<roundId>.png` に保存され request_json に dataUrl が残らないこと

## 今後の方向（今回スコープ外）

- siglip/unCLIP 追加スタイル条件付け、顔アップスケール(4xFaceUpDAT)
- 元ワークフローの GGUF v37 / UnetLoaderGGUFAdvancedDisTorchMultiGPU / t5xxl_fp16 へのベース変更
- レガシー動的パッチ経路（roleMap）の撤去（別フィーチャー）
- モデルファミリ抽象化（chroma 以外の追加）

## 未決事項（実装中に判断）

- PuLID / IP-Adapter の strength を UI に露出するか（初期は固定値、必要なら per-reference スライダを後付け）
- Hyper LoRA を完全自動挿入にするか、モデル選択 UI に小さなトグルを設けるか

## 実施記録(2026-07-07): Phase 0〜4 完了

worktree `guruguru-wt-consistent-char`(ブランチ `feature/consistent-character`)でコミット済み。

- **Phase 0〜3**: 計画どおり実施。`workflowFeatureFragments.ts`(新規)+ `workflowUnifiedSwitch.ts` 接続 +
  `modelCheck.ts` の feature 別可用性 + `rounds.ts` の参照画像アップロード。単体テスト25件追加
  (フラグメント組み立て10件・CN prune 2件・`patchUnifiedSwitchWorkflow` 統合テスト7件・model-check複合キー
  修正1件 ほか)。`npm test` 381/381、`npm run typecheck` 0エラー。
- **Phase 4**: 生成フォームに「参照画像」枠(親画像の直下)+ 顔スタイル参照/全体スタイル参照トグルを追加
  (`referenceController.ts` 新規)。install モーダルを feature別カード表示に拡張(`requiredNodePacks`/
  `missingNodePacks` を追加)。Project 展開時に `refreshModelCheck("chroma")` を先行実行し、モーダルを
  開かなくてもトグルの disabled 判定ができるようにした。
- **実機ブラウザ検証**(テスト用データディレクトリ + **本番 ComfyUI 8188 への疎通確認レベルAPI呼び出しのみ**、
  生成は一切行っていない):
  - 参照画像のアップロード→プレビュー→クリアが動作
  - 顔/スタイルトグルが実際の `/api/comfy/model-check` 結果(本番8188の実データ)に応じて正しく
    disabled/tooltip表示: PuLID系ノードは存在するがモデルファイル名不一致→「未確認」、x-flux-comfyui
    不在→ノードパックごと disabled、comfyui-easy-use(RMBG)存在→有効 — 設計どおりの3パターンを
    実データで確認できた
  - install モーダルの feature カードが正しくレンダリング。検証中に発見した CSS 折り返しバグ
    (`table-layout` 未指定でネストしたテーブルの長いパスがダイアログをはみ出す)を修正済み

### 残課題(Phase 5、ユーザー判断待ち)

> **→ 2026-07-07 解決済み。** テスト用 ComfyUI(8288)へ PuLID-Flux / x-flux-comfyui を実導入し、
> 参照画像を使った実生成で PuLID 顔同一性転写まで含めた完走を確認した。詳細は末尾
> 「## Phase 5 実施記録(2026-07-07): 実機生成検証 完了」を参照。

**実際に PuLID-Flux(Chroma対応fork) / x-flux-comfyui / (任意で comfyui-easy-use) をどこかの ComfyUI へ
導入し、参照画像を使った実生成(顔同一性・スタイル反映)を確認する**工程が残っている。これは
insightface・onnxruntime・facexlib 等の重い依存追加を伴い、共有 Python 環境(Desktop版流用の
`standalone-env`)を壊すリスクがあるため、着手前にユーザーへの確認が必要(このドキュメントの
「Phase 1 実施記録」に記載の判断を踏襲)。テスト用 ComfyUI(8288)へ導入するか、ユーザー自身の
環境で確認するかは要相談。

コード自体は上記の実機ブラウザ検証(本番ComfyUIの実データでの可用性判定)により、
「導入済みモデル/ノードパックに応じて機能をON/OFFする」という本機能の中核設計が実際に機能する
ことは確認済み。残る不確実性は「実際に生成した画像が意図通り(顔が似ている・スタイルが反映される)か」
という品質面のみ。

## Phase 1 実施記録（2026-07-07）: 実機確認の代替手段と確定した実データ

テスト用 ComfyUI(8288) の `custom_nodes` は空(model-select機能検証時のまま)で、PuLID-Flux/x-flux-comfyui/
comfyui-easy-use は未導入。これらは insightface・onnxruntime・facexlib 等の重い C 拡張依存を伴い、
Desktop 版と共有している `standalone-env` へ pip install するのは、他機能の検証にも使う共有環境を壊すリスクが
ある(操作メモ.md: torch 消失時の再インストール事例が既にある通り環境自体が脆い)。そのため **実際にパックを
導入して `/object_info` を叩く代わりに、各パックの GitHub 上のノード実装ソースを直接読んで INPUT_TYPES を
確定**した(`PaoloC68/ComfyUI-PuLID-Flux-Chroma` の `pulidflux.py`、`XLabs-AI/x-flux-comfyui` の `nodes.py`、
`yolain/ComfyUI-Easy-Use` の `py/nodes/image.py`)。参照ワークフロー JSON の `widgets_values` 個数・順序と
突合し、一致することを確認済み(下表)。**実際のカスタムノードパックをテスト環境に導入しての `/object_info`
実機確認・生成テストは、共有 Python 環境への重い依存追加を伴うため、着手前にユーザーへ確認する**
(Phase 5 検証時の注意事項として引き継ぐ)。

### 確定した入力名・モデルディレクトリ

| ノードクラス | 入力名 | folder_paths カテゴリ | 配置先 | 備考 |
|---|---|---|---|---|
| `PulidFluxModelLoader` | `pulid_file` | `pulid` | `models/pulid` | |
| `PulidFluxInsightFaceLoader` | `provider`(CPU/CUDA/ROCM) | — | `models/insightface`(自動DL) | ファイル選択なし。antelopev2 を自動取得 |
| `PulidFluxEvaClipLoader` | (入力なし) | — | —(自動DL) | EVA02-CLIP-L-14-336 を自動取得 |
| `ApplyPulidFlux` | model/pulid_flux/eva_clip/face_analysis/image + optional attn_mask/**prior_image** + weight/start_at/end_at/fusion/fusion_weight_max/fusion_weight_min/train_step/use_gray | — | — | `prior_image` が「顔参照画像」の実体(train_weight fusion 時のターゲット) |
| `LoadFluxIPAdapter` | **`ipadatper`**(原文ママ、タイポ) | `xlabs_ipadapters` | `models/xlabs/ipadapters` | 入力名のタイポに注意。model-check の照合キーもこれに合わせる |
| `LoadFluxIPAdapter` | `clip_vision` | `clip_vision`(コア共通) | `models/clip_vision` | コアの `CLIPVisionLoader` は入力名 `clip_name` のため衝突なし |
| `ApplyAdvancedFluxIPAdapter` | model/ip_adapter_flux/image + begin_strength/end_strength/**smothing_type**(原文ママ、タイポ) | — | — | |
| `easy imageRemBg`(comfyui-easy-use) | images + rem_mode(固定enum: RMBG-2.0/RMBG-1.4/Inspyrenet/BEN2)/image_output/save_prefix + optional torchscript_jit/add_background/refine_foreground | — | REMBG_DIR に自動DL | **ファイル選択ウィジェットが無い**(rem_mode は固定リストで、モデル実体は初回使用時に自動DL)。この feature の必要モデルファイル一覧は空にし、ノードパック存在チェックのみで可用性を判定する |

MODEL チェーン順・ウィジェット値は参照ワークフロー JSON と完全一致(`ApplyPulidFlux` の8ウィジェット、
`LoadFluxIPAdapter` の出力名 `ipadapterFlux`、`ApplyAdvancedFluxIPAdapter` の3ウィジェット、
`easy imageRemBg` の6ウィジェット、すべて順序含め一致)。ただし参照 JSON の `ApplyPulidFlux` には
`options`(OPTIONS型、未接続)という追加の optional 入力があり、取得した `main` ブランチのソースには
無い。未接続のため実装上は無視してよい(新しめのバージョン差分と思われる)。

これにより `ModelKind` を拡張する: `pulid` / `ipadapterFlux` / `clipVision` を追加
(`pulid_file`→`pulid`、`ipadatper`→`ipadapterFlux`、`clip_vision`→`clipVision`)。
RMBG は `models` 要件が空配列になる想定で feature スキーマを設計する(ノードパック存在のみで可用性判定)。

## Phase 5 実施記録(2026-07-07): 実機生成検証 完了

テスト用 ComfyUI(8288)へカスタムノードパックを実導入し、参照画像を使った **PuLID 顔スタイル参照付き
txt2img 実生成を完走**させ、本機能の中核設計(フラグメント注入・機能可用性ゲート・参照画像永続化)が
実データで正しく動くことを end-to-end で確認した。

### 環境

- テスト用 ComfyUI(8288)の `custom_nodes` に `ComfyUI-PuLID-Flux-Chroma`・`x-flux-comfyui` を clone、
  依存(insightface/onnxruntime/facexlib 等)を共有 `standalone-env` へ prebuilt wheel でインストール
  (Python 3.13、コンパイル不要・環境破壊なし)。`comfyui-easy-use`(RMBG)は未導入のまま。
- 共有モデルディレクトリに `pulid_flux_v0.9.1.safetensors` と ControlNet モデルは配置済み。
  IP-Adapter モデル(`ip_adapter.safetensors`/`clip-vit-large-patch14.safetensors`)・Hyper LoRA は未配置。

### 確認できたこと

1. **機能可用性ゲート(実データ)**: `GET /api/comfy/model-check?family=chroma` の features は
   `pulid: available`(ノード+モデル両方揃う)、`controlnet: available`、`ipadapter: false`(ノードは有るがモデル無し)、
   `rmbg: false`(ノードパック comfyui-easy-use 無し)、`lora: false`(モデル無し)。
   UI 上でも **顔スタイル参照(PuLID)トグルは有効・全体スタイル参照(IP-Adapter)トグルは disabled** と
   設計どおりに差別化された。
2. **PuLID 実生成の完走**: 生成フォームの参照画像枠に顔写真(scikit-image 同梱のパブリックドメイン
   飛行士写真)をアップロード → 顔スタイル参照 ON → txt2img 生成。ComfyUI ログで
   InsightFace 顔検出 → EVA-CLIP → `ApplyPulidFlux` の fusion(`online training, ending...`)→
   サンプリング完走 → VAEデコード → `Prompt executed` を確認。**16枚バッチが status=completed で完了し、
   生成画像に参照顔の同一性が転写されている**ことを目視確認(品質評価は本検証の対象外)。
   → フラグメント注入で PuLID サブグラフが MODEL チェーンへ正しく差し込まれ、ComfyUI のグラフ全体検証を
   通過して実行されることが実証された。
3. **参照画像の永続化と request_json のクリーン化**: `reference/<roundId>.jpg` に保存され、DB の
   `generation_rounds.request_json` の `reference.imageDataUrl` は `null`・`imagePath` のみ保持で、
   request 全体に `data:image` が残らないことを確認(mask/pose と同じ規約どおり)。

### 落とし穴(環境側・アプリのスコープ外だが要記録)

- **InsightFace antelopev2 の二重ネスト**: PuLID の `PulidFluxInsightFaceLoader` が初回に antelopev2 を
  自動DL・展開するが、`models/insightface/models/antelopev2/antelopev2/*.onnx` と1階層深く展開され、
  InsightFace の `FaceAnalysis(name="antelopev2", root=…)` が `assert 'detection' in self.models` で落ちる。
  `.onnx` を `models/insightface/models/antelopev2/` 直下へ移動(フラット化)すれば解消。これはユーザーが
  PuLID を導入する際にも踏みうるので、install 案内(あるいは操作メモ)へのメモ候補。**アプリのコード側の
  問題ではない**(GURUGURU は InsightFace のモデル配置を管理しない)。

### スコープ内で未実施(モデルファイル入手が必要・任意)

- IP-Adapter(x-flux のモデルファイル)/ RMBG(comfyui-easy-use)/ Hyper LoRA の実生成完走は、
  追加のモデルダウンロードが必要なため未実施。コードの可用性判定・フラグメント組み立て・CN prune は
  ユニットテスト(25件)と実データの feature 可用性で検証済みなので、必須ではない。必要ならモデル配置後に
  同手順で確認可能。
