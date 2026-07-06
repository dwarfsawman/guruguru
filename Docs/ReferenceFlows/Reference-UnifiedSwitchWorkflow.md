# Reference: 統合 Switch ワークフロー

`Reference-UnifiedSwitchWorkflow.json` の解説。txt2img / img2img / inpaint（maskedContent 4種）/
ControlNet有無 を**1つのワークフロー**で表現し、モード切り替えは `PrimitiveBoolean` 6個の値の
書き換えだけで行う。現行のワークフロー動的パッチ方式（ノードの追加・配線替え）に代わる、参照用の設計。

すべて ComfyUI コアノードのみ（`ComfySwitchNode` / `PrimitiveBoolean` は `comfy_extras.nodes_logic` /
`nodes_primitive` 由来の組み込みノード。experimental 扱いだがカスタムノード不要）。

## モード制御（PrimitiveBoolean 6個）

| ノード | 意味 | 駆動する switch |
|---|---|---|
| `770` use-parent-image | false=txt2img / true=img2img系 | `757` latent-image-switch, `769` sigmas-switch |
| `771` use-mask | true=inpaint（`770`=true のときのみ意味を持つ） | `765` mask-switch, `790` save-image-switch |
| `772` use-controlnet | ControlNet 適用の有無 | `766` positive-switch, `767` negative-switch |
| `780` use-empty-latent-content | true=latent_noise/latent_nothing 系 | `783` masked-content-switch |
| `781` use-fill | false=original / true=fill | `784` pixel-content-switch |
| `782` use-noise-mask | false=latent_nothing / true=latent_noise | `785` empty-content-switch |

| モード | 770 | 771 | 780 | 781 | 782 | 772 |
|---|---|---|---|---|---|---|
| txt2img | false | false | - | - | - | 任意 |
| img2img | true | false | - | - | - | 任意 |
| inpaint (original) | true | true | false | false | false | 任意 |
| inpaint (fill) | true | true | false | true | false | 任意 |
| inpaint (latent_noise) | true | true | true | false | true | 任意 |
| inpaint (latent_nothing) | true | true | true | false | false | 任意 |

maskedContent の 4 値は 2 段の switch ツリーで表現する（`765` mask-switch の on_true → `783`）:

- `783` masked-content-switch: on_false=ピクセル系（original/fill）/ on_true=空潜在系
- `784` pixel-content-switch: on_false=`764` SetLatentNoiseMask（original）/ on_true=`786` VAEEncodeForInpaint（fill）
- `785` empty-content-switch: on_false=`788`（latent_nothing）/ on_true=`787` SetLatentNoiseMask（latent_noise）
- `788` LatentMultiply（`761` VAEEncode × 0）= **親画像と同サイズのゼロ潜在**。`737` EmptySD3LatentImage は
  フォームの幅・高さ依存で親画像サイズと一致しないため、latent 系の空潜在には使わない

### inpaint 時のペーストバック（`789` / `790`）

latent_noise / latent_nothing はマスク外の潜在が空になり、デコード結果のマスク外が灰色になるため、
`789` ImageCompositeMasked（destination=親画像 `762`、source=デコード結果 `298`、mask=`763`）で
マスク外を親画像ピクセルで復元する。`790` save-image-switch（`771` と bool 共有）が
inpaint 時のみ `789` を、それ以外は素のデコード結果を SaveImage `740` へ渡す。
original / fill でもペーストバックが効くため、マスク外の VAE 往復劣化が無くなる（動的パッチ経路と同等）。

1つの Boolean を複数 switch で共有できること、switch の `on_false`/`on_true` が lazy 評価で
選ばれない枝は実行されないこと（ControlNet オフならモデルロードも走らない）は実機検証済み（2026-07-03）。

## アプリが生成時に動的に書き込む入力

| ノード | 入力 | 内容 |
|---|---|---|
| `770` `771` `772` `780` `781` `782` | `value` | モードに応じた true/false（maskedContent 系 3 個も毎回書き込み、前回モードを引きずらない） |
| `786` | `grow_mask_by` | fill 時のみ `onlyMaskedPadding` を 0..64 にクランプして書き込む |
| `762` LoadImage | `image` | 親画像のアップロード名。**未使用時（txt2img）はダミー画像名** |
| `763` LoadImageMask | `image` | マスクのアップロード名。**未使用時はダミー画像名**（channel は red 固定） |
| `754` LoadImage | `image` | ControlNet 制御画像名。**未使用時はダミー画像名** |
| `748` / `749` | `text` | positive / negative プロンプト |
| `718` | `noise_seed` | シード |
| `737` | `width` `height` `batch_size` | 出力サイズ・バッチ（txt2img 時） |
| `768` | `denoise` | img2img のデノイズ強度（`734` は txt2img 用に denoise=1 固定） |
| `752` | `strength` `start_percent` `end_percent` | ControlNet パラメータ |

## ダミー画像の扱い（重要な制約）

ComfyUI のプロンプト検証は **lazy 評価に関係なくグラフ全体に走る**。選ばれない枝の
`LoadImage` / `LoadImageMask` でもファイル名が実在しないと prompt 全体が
`Invalid image file` で拒否される（実機検証済み）。

対応: アプリ起動時（または初回生成時）に 1px 程度のダミー PNG を `/upload/image` で
一度アップロードしておき、未使用モードの画像入力にはそのダミー名を常に書き込む。
lazy によりダミーが実際に読まれることはない。

## 現行実装との対応・簡略化している点

- maskedContent は 4 値すべて対応（2026-07-06）。**旧インポート済みテンプレート（content-switch
  ツリーなし）では original 以外を要求すると生成時エラーになる**ため、fill 等を使うには
  この参照 JSON を再インポートする。original のみの利用なら再インポート不要（レガシー構造も
  `resolveUnifiedSwitchRoles` が引き続き解決する）
- 現行実装が動的挿入している `ImageScale`（リサイズ）、`GrowMask`+フェザー、
  `RepeatLatentBatch` は見通し優先で省略（fill の grow は `786` の `grow_mask_by` widget で代替）。
  ペーストバックは `789`/`790` として組み込み済み
- denoise は widget 値で switch できないため、`BasicScheduler` を txt2img 用（`734`）と
  img2img 用（`768`）の2個並べて sigmas 出力を `769` で切り替える方式

## 元ワークフローからの修正点

- `761` VAEEncode に欠けていた `vae: ["710", 0]` を追加（元 JSON は実行エラーになる）
- 孤立していた `755`（2個目の ControlNetLoader）を削除
- `752` ControlNetApplyAdvanced に `vae: ["710", 0]` を追加（2026-07-03）。Chroma/Flux 系
  ControlNet は VAE 接続が必須で、無いと prompt 検証は通るがサンプリング時に
  `This Controlnet needs a VAE but none was provided` で失敗する（実機で発生）。
  SD1.5/SDXL 系 ControlNet は vae 入力を無視するため接続していて害はない。
  なお `patchUnifiedSwitchWorkflow` は vae 未接続の旧インポート済みテンプレートにも
  自動でこの接続を復元するため、登録済みテンプレートの再インポートは不要。
