# Reference: 統合 Switch ワークフロー

`Reference-UnifiedSwitchWorkflow.json` の解説。txt2img / img2img / inpaint / ControlNet有無 を
**1つのワークフロー**で表現し、モード切り替えは `PrimitiveBoolean` 3個の値の書き換えだけで行う。
現行のワークフロー動的パッチ方式（ノードの追加・配線替え）に代わる、参照用の設計。

すべて ComfyUI コアノードのみ（`ComfySwitchNode` / `PrimitiveBoolean` は `comfy_extras.nodes_logic` /
`nodes_primitive` 由来の組み込みノード。experimental 扱いだがカスタムノード不要）。

## モード制御（PrimitiveBoolean 3個）

| ノード | 意味 | 駆動する switch |
|---|---|---|
| `770` use-parent-image | false=txt2img / true=img2img系 | `757` latent-image-switch, `769` sigmas-switch |
| `771` use-mask | true=inpaint（`770`=true のときのみ意味を持つ） | `765` mask-switch |
| `772` use-controlnet | ControlNet 適用の有無 | `766` positive-switch, `767` negative-switch |

| モード | 770 | 771 | 772 |
|---|---|---|---|
| txt2img | false | false | 任意 |
| img2img | true | false | 任意 |
| inpaint (maskedContent=original) | true | true | 任意 |

1つの Boolean を複数 switch で共有できること、switch の `on_false`/`on_true` が lazy 評価で
選ばれない枝は実行されないこと（ControlNet オフならモデルロードも走らない）は実機検証済み（2026-07-03）。

## アプリが生成時に動的に書き込む入力

| ノード | 入力 | 内容 |
|---|---|---|
| `770` `771` `772` | `value` | モードに応じた true/false |
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

- inpaint は既定の `maskedContent=original`（`VAEEncode` → `SetLatentNoiseMask`）のみ表現。
  `fill`（`VAEEncodeForInpaint`）を足す場合は `765` の後段にもう1つ switch を挟む
- 現行実装が動的挿入している `ImageScale`（リサイズ）、`GrowMask`+フェザー、
  `ImageCompositeMasked`（ペーストバック）、`RepeatLatentBatch` は見通し優先で省略
- denoise は widget 値で switch できないため、`BasicScheduler` を txt2img 用（`734`）と
  img2img 用（`768`）の2個並べて sigmas 出力を `769` で切り替える方式

## 元ワークフローからの修正点

- `761` VAEEncode に欠けていた `vae: ["710", 0]` を追加（元 JSON は実行エラーになる）
- 孤立していた `755`（2個目の ControlNetLoader）を削除
