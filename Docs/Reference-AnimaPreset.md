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

モデルファミリはワークフロー内の `anima-*` または `qwen_3_06b_base` から判定し、ComfyUI モデル確認と生成時 feature gate の両方へ渡す。
