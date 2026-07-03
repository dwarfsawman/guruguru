# Feature: 統合 Switch ワークフロー方式のサイド実装

起票: 2026-07-03 / 実装完了: 2026-07-03

## 背景（現状の問題）

「親画像読み込み + pose 設定 + ブランチング」の生成で ComfyUI `/prompt` が 400 を返した:

```
node_errors.757 (ImageScale): return_type_mismatch
  image, received_type(CONDITIONING) mismatch input_type(IMAGE)  linked_node: ["752", 0]
```

原因は DB に保存済みの古いテンプレート roleMap。`inferRoleMap` 修正（コミット 6398369）以前に
推論された roleMap では `load_image_input` が `752.inputs.image`（= **ControlNetApplyAdvanced
ノード自身**の image 入力）を指しており、`sanitizeRoleMap` は「control 画像供給 LoadImage との
衝突」しか除去しないため、このケースがすり抜けていた。結果:

1. `patchImg2ImgLatentPath` が node 752 を「親画像の LoadImage」と誤認
2. 動的追加した ImageScale(757) の `image` 入力を `["752", 0]`（CONDITIONING 出力）へ配線
3. ComfyUI のグラフ検証で `return_type_mismatch` → prompt 全体が 400

この種の「roleMap 誤推論 → 動的パッチが誤配線」という失敗モードは今回で3例目
（vae_encode / control 供給 LoadImage / apply ノード自身）。動的パッチ方式の複雑さが根本にある。

## 対応（2本立て）

### 1. 根本原因の修正（動的パッチ方式の防御強化）

- `sanitizeRoleMap`（`src/server/workflowGraph.ts`）: `load_image_node` / `load_image_input` の
  参照先が **LoadImage 系ノードでない場合は無条件に破棄**する分岐を追加。
- `resolveParentLoadImageNode`（`src/server/workflowInpaint.ts`）: 解決したノードが LoadImage
  系クラスであることを検証し、そうでなければ新規 LoadImage を追加する（多層防御）。
- 回帰テスト: `workflow.test.ts` に「stale roleMap が apply ノード自身を指すケースで
  ImageScale が CONDITIONING 出力を読まない」ことを検証するテストを追加。

既存テンプレートは再登録不要（patch 時に毎回 sanitize されるため）。

### 2. 統合 Switch ワークフロー方式のサイド実装

`Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.md` の設計に基づく別方式を実装。
テンプレートが `ComfySwitchNode` を含む場合、**動的パッチ（ノード追加・配線替え）を一切行わず**、
`PrimitiveBoolean` 3個の値と各入力値の書き込みだけで txt2img / img2img / inpaint /
ControlNet 有無を切り替える。

#### 新規ファイル: `src/server/workflowUnifiedSwitch.ts`

- `isUnifiedSwitchWorkflow(workflow)` — `class_type === "ComfySwitchNode"` を持つノードの有無で判定。
- `resolveUnifiedSwitchRoles(workflow)` — **roleMap を使わず**、sampler から構造的にグラフを
  たどって全パッチ対象を解決（node id・タイトルに依存しないため再エクスポートにも耐える）:
  - `sampler.latent_image` → latent switch → `switch`=use-parent-image Boolean /
    `on_false`=EmptyLatent / `on_true`= [mask switch →] VAEEncode → `pixels`= 親画像 LoadImage
  - mask switch の `on_true` → SetLatentNoiseMask → `mask` = LoadImageMask
  - `sampler.sigmas` → sigmas switch → `on_false`=txt2img scheduler / `on_true`=img2img scheduler
  - `guider.positive` → CN switch → `switch`=use-controlnet Boolean / `on_false`=positive
    CLIPTextEncode / `on_true`=ControlNetApplyAdvanced → `image`= 制御画像 LoadImage
  - `sampler.noise`（seed）/ `sampler.sampler`（sampler_name）/ CFGGuider（cfg）/ SaveImage
- `patchUnifiedSwitchWorkflow(workflow, context, savePrefix)` — 値の書き込みのみ。
  構造検証に失敗した場合は分かりやすいメッセージで throw（ラウンドは failed になりエラーが見える）。

#### モード → Boolean 対応

| モード | use-parent-image | use-mask | use-controlnet |
| --- | --- | --- | --- |
| txt2img | false | false | pose 添付時のみ true |
| img2img | true | false | pose 添付時のみ true |
| inpaint (maskedContent=original) | true | true | pose 添付時のみ true |
| generationMode=controlnet | false | false | true（親画像を制御画像として使用） |

#### ダミー画像（未使用ブランチの LoadImage 対策）

ComfyUI の prompt 検証は lazy 評価に関係なくグラフ全体の画像ファイル名実在を要求するため、
未使用モードの LoadImage / LoadImageMask には事前アップロードした 1px PNG
（`guruguru-dummy.png`）を書き込む。

- `src/server/comfy.ts` に `ensureDummyComfyImage()` を追加（プロセスごとに1回だけ
  `/upload/image`、失敗時はキャッシュを破棄して次回リトライ）。
- `src/server/rounds.ts` が unified テンプレート検出時のみアップロードし、
  `PatchContext.dummyImageName` として渡す。

#### 接続点

- `patchWorkflow`（`src/server/workflow.ts`）冒頭で unified 判定 → `patchUnifiedSwitchWorkflow`
  へディスパッチ。roleMap は一切参照しないので誤推論の影響を受けない。
- テンプレート登録は従来どおり（UI から `Reference-UnifiedSwitchWorkflow.json` をインポート
  するだけ。inferRoleMap が生成する roleMap は保存されるが patch では未使用）。

## 従来方式（動的パッチ）から簡略化している点

参照設計ドキュメントの記載どおり、見通し優先で以下は非対応:

- inpaint は `maskedContent="original"` のみ（それ以外は明示的にエラー）。
  `fill` 等が必要な場合は従来テンプレートを使う。
- `ImageScale`（親画像リサイズ）なし → img2img の出力サイズは親画像サイズに従う。
- `GrowMask` + feather、`ImageCompositeMasked`（ペーストバック）なし。
- `RepeatLatentBatch` なし（rounds.ts が batch をジョブ分割するため実害なし。
  `batch_size` は EmptyLatent にのみ反映）。

## 検証

- `npm test` 278件パス（unified 11件 + stale roleMap 回帰 1件を新規追加）
- `npm run typecheck` / `npm run check` パス
- テストは実際の `Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json` を読み込み、
  txt2img / img2img / inpaint / pose ControlNet / generationMode=controlnet /
  poisoned roleMap 無視、を検証

## 実機での確認手順

1. アプリの Workflows 画面から `Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json` を
   インポート（roleMap は自動推論のままで OK — unified 方式では使用されない）
2. ComfyUI 側に `ComfySwitchNode` / `PrimitiveBoolean` が存在すること
   （`comfy_extras.nodes_logic` / `nodes_primitive` 由来のコアノード。カスタムノード不要）
3. txt2img → img2img（親画像）→ inpaint → pose 添付、の順に各モードで1枚ずつ生成して確認

## 追補: ControlNet の VAE 必須エラー修正（2026-07-03）

初回実機テストで、prompt 検証は通るがサンプリング実行時に ComfyUI 側で失敗するケースが出た:

```
execution_error node 747 (SamplerCustomAdvanced): ValueError
  This Controlnet needs a VAE but none was provided,
  please use a ControlNetApply node with a VAE input and connect it.
```

Chroma/Flux 系 ControlNet（`diffusion_pytorch_model.safetensors` 等）は
`ControlNetApplyAdvanced` の optional な `vae` 入力の接続が必須（SD1.5/SDXL 系は無視するだけ）。
リファレンスワークフローの `752` に `vae` 接続が無かった。対応:

- `Reference-UnifiedSwitchWorkflow.json` の `752` に `vae: ["710", 0]` を追加
- `patchUnifiedSwitchWorkflow` に、CN apply ノードの `vae` が未接続なら
  img2img 用 VAEEncode と同じ VAE 接続を自動復元する処理を追加
  （**修正前にインポート済みのテンプレートも再インポート不要で動く**）
- 回帰テスト3件追加（リファレンス JSON の vae 接続 / 未接続テンプレートへの復元 /
  既存接続の非上書き）で `npm test` 281件パス

実機検証: Desktop 版 ComfyUI のコード・venv・共有モデルパスを流用したテスト用
インスタンス（port 8288、独立 base/output/input/temp ディレクトリ）を起動し、
テストDBの GURUGURU から vae 無しテンプレート登録 → generationMode=controlnet
（512x288 / 6 steps、GPU 負荷抑制）で生成成功・ポーズ追従を確認、
続けて txt2img も成功を確認。テスト用インスタンスの起動には
`custom_nodes` ディレクトリの事前作成が必要（無いと起動時に FileNotFoundError）。
