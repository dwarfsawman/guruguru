# Anima プリセット

## 構成

`ReferenceFlows/Reference-AnimaUnifiedSwitchWorkflow.json` は Anima Base v1.0 用の API 形式ワークフローで、モデル選択の Anima モーダルから WorkflowTemplate として追加する。

| 種別 | ファイル | ComfyUI 配置先 |
| --- | --- | --- |
| diffusion model | `anima-base-v1.0.safetensors` | `models/diffusion_models` |
| text encoder | `qwen_3_06b_base.safetensors` | `models/text_encoders` |
| VAE | `qwen_image_vae.safetensors` | `models/vae` |

公式構成に合わせ、`UNETLoader`、`CLIPLoader(type=stable_diffusion)`、Qwen Image VAE、`er_sde` / `simple` / 30 steps / CFG 4 を既定にする。プロンプト方言は tags、quality prefix は `masterpiece, best quality, score_7, safe`。

## 対応範囲

- txt2img、img2img、4種の `maskedContent` を含む inpaint は統合 Switch 経路を共有する。
- Anima 用 `LoraLoaderModelOnly` LoRA は UNET と `CFGGuider` / 2本の `BasicScheduler` の間へ同じチェーンを挿入する。Chroma/SDXL 用 LoRA を流用しない。
- Chroma 用 ControlNet と PuLID-Flux はアーキテクチャ非互換のため Anima では常に無効。ControlNet モードは生成前に明示エラーにする。参照画像の PuLID トグルは Anima 生成へ注入しない。
- 実験機能として、既存の1枚参照を Anima In-Context Character へ渡せる。`anima-incontext-character.safetensors` と対応ノードが揃う場合だけ自動有効化し、未導入ならbase生成へ安全に戻す。

モデルファミリはワークフロー内の `anima-*` または `qwen_3_06b_base` から判定し、ComfyUI モデル確認と生成時 feature gate の両方へ渡す。

## Anima In-Context Character PoC

現行PoCは、生成フォームまたは主役キャラクターバインディングから解決した1枚の参照画像をRound専用ファイルへコピーし、ComfyUIへ1回だけuploadする。ワークフロー送信直前に次のMODELチェーンを動的に組み立てる。

`UNETLoader → ユーザーLoRA群 → anima-incontext-character LoRA → AnimaInContextApply`

`AnimaInContextApply.ref_latent` には `LoadImage → AnimaRefEncode(VAELoader)` を接続する。Apply後のMODELを`CFGGuider`とtxt2img/img2img両方の`BasicScheduler`へ同時に配線する。既定値はstrength 1、start 0、end 1、`cond_only=true`、`fit_mode=pad`で、参照encodeのtarget sizeは生成width/heightである。

必要物は次のとおり。

- `ComfyUI/models/loras/anima-incontext-character.safetensors`（PoCではroot直下のchoice文字列を固定使用）
- `AnimaRefEncode`、`AnimaRefLatentBatch`、`AnimaInContextApply`を登録する外部ノードパック
- Anima Base v1.0テンプレート

モデル選択のAnimaモーダルは、adapterとノード入力schemaを`/object_info`で確認する。生成時も同じ判定を行い、Chromaへ誤注入しない。サブフォルダ内の同名adapterは「導入済み」とみなさない。

### PoCの境界

- 参照は1枚のみ。推奨される「顔アップ＋全身」の2枚Reference Set、`AnimaRefLatentBatch`による結合、複数人物の参照分離は未実装。
- 既存のキャラクターシート採用APIは顔cropだけをバインディングするため、現時点で「Anima Ready」とは扱わない。次段ではcharacterごとのface/full-bodyスロットと承認UXを追加する。
- 参照はGeneration Round単位では固定されるが、Script Manga Run全体の再試行で同一Reference Setを固定するrun-level snapshotは未実装。
- 外部配布物は新しく実験的で、adapterのモデルカードは非商用派生物としている。外部ノードコードのライセンスも導入前に確認し、GURUGURUのDockerイメージには自動同梱しない。
- 実機A/Bは本番8188ではなく、`sandbox/scripts/check-anima.mjs`を隔離8288に対して実行する。参照元とは異なる固定seed・ポーズ・背景のターゲットを参照なし／参照ありで生成し、Dockerが未起動・必要物が未導入の場合は理由付きskipとなる。
