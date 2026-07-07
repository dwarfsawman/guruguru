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

- カスタムノードの正確な入力名・モデル配置先（Phase 1 で `/object_info` から確定）
- PuLID / IP-Adapter の strength を UI に露出するか（初期は固定値、必要なら per-reference スライダを後付け）
- Hyper LoRA を完全自動挿入にするか、モデル選択 UI に小さなトグルを設けるか
