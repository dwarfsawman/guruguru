# エージェント向けインスタンス / 画像生成 API

## インスタンス境界

`bun run start:agent` はユーザー用 `5177` と分離した、エージェント向けの永続インスタンスを起動する。
既定は `127.0.0.1:5199`、データは Windows では `%LOCALAPPDATA%\GURUGURU-AGENT` に保存される。
これは `GURUGURU_TEST_DB=1` の一時DBではなく、通常DBと同じmigration・永続化を使う独立インスタンスである。

- ポート変更: `GURUGURU_AGENT_PORT`（`5177` は拒否）
- データ場所変更: `GURUGURU_AGENT_DATA_DIR`（リポジトリ内は拒否）
- 既定ComfyUI変更: `GURUGURU_DEFAULT_COMFY_BASE_URL` / `GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL`
- ランチャーは親シェルの `GURUGURU_TEST_DB` / `GURUGURU_TEST_DATA_DIR` / `NODE_ENV` を子へ引き継がない。
- 既定ComfyUIは隔離インスタンス `http://127.0.0.1:8288`。永続DBですでに設定を保存済みなら、その保存値を優先する。

`GET /api/health` の `instanceMode` は `agent`、`GET /api/agent/capabilities` の `agentReady` は `true` になる。
自動テストや使い捨てsmokeは引き続き `GURUGURU_TEST_DB=1` / `bun run start:test` を使い、エージェント用永続DBをテストfixtureにしない。

## Anima APIフロー

APIはUIと同じ保存・検証経路を使う。画像はData URLで送り、サーバーがRound専用ファイルへ保存した後、DBにはData URLを残さない。

1. `POST /api/model-presets/anima` でINT8 Animaプリセットを追加し、返された `template.id` を保持する。
2. `POST /api/projects` でプロジェクトを作る。img2img/inpaintでは、先に `POST /api/projects/:projectId/source-assets` へ元画像をData URLで送り、返された `asset.id` を保持する。
3. `POST /api/projects/:projectId/rounds` で生成する。
4. `POST /api/rounds/:roundId/collect` で完了画像を収集する（通常はサーバー監視も自動収集する）。

共通のAnima既定値は `sampler: "er_sde"`、`scheduler: "simple"`、`steps: 30`、`cfg: 4`。INT8本体は
`animaInt8Mxfp8_aestheticV11Int8.safetensors` で、`UNETLoader.weight_dtype` は `default` のまま使用する。

### inpaint

`generationMode: "img2img"`、`parentAssetId`、親画像と同寸法のPNG Data URLを `inpaint.maskDataUrl` に指定する。

```json
{
  "templateId": "<anima-template-id>",
  "prompt": "masterpiece, best quality, score_7, safe, ...",
  "negativePrompt": "worst quality, low quality, ...",
  "seed": 12345,
  "seedMode": "fixed",
  "batchSize": 1,
  "steps": 30,
  "cfg": 4,
  "sampler": "er_sde",
  "scheduler": "simple",
  "denoise": 0.7,
  "width": 768,
  "height": 768,
  "generationMode": "img2img",
  "parentAssetId": "<source-asset-id>",
  "inpaint": {
    "maskDataUrl": "data:image/png;base64,...",
    "maskedContent": "original",
    "inpaintArea": "only_masked",
    "onlyMaskedPadding": 6
  }
}
```

Animaは既存のlatent mask経路だけでもinpaintできる。`AnimaLLLiteApply` と
`anima-lllite-inpainting-v2.safetensors` がある場合は、親画像+白=inpaint領域のmaskを4ch LLLiteにも渡して補助する。

### ポーズControlNet / inpaint併用

OpenPose画像のPNG Data URLを `controlnet.poseImageDataUrl` に指定する。txt2imgへ添付できるほか、上記inpaint bodyへ同じオブジェクトを追加して併用できる。

```json
{
  "controlnet": {
    "poseImageDataUrl": "data:image/png;base64,...",
    "strength": 0.8,
    "startPercent": 0,
    "endPercent": 0.85
  }
}
```

Anima ControlNetはChroma用 `ControlNetApplyAdvanced` を流用しない。`ComfyUI-Anima-LLLite` の
`AnimaLLLiteApply` と `models/controlnet/anima-lllite-pose-1.safetensors` を使い、MODELチェーンを
`UNET → ユーザーLoRA → In-Context（任意）→ inpaint LLLite（任意）→ pose LLLite（任意）` の順に組む。
複数LLLiteは `preserve_wrapper=true` でcascadeする。ノードまたはpose weightが無い場合は、ControlNet画像を黙って無視せず生成前に明示エラーにする。

## モデル確認

`GET /api/comfy/model-check?family=anima` はベースINT8/encoder/VAEに加え、次の任意機能を個別表示する。

- `animaInpaint`: `AnimaLLLiteApply` + `anima-lllite-inpainting-v2.safetensors`
- `animaControlnet`: `AnimaLLLiteApply` + `anima-lllite-pose-1.safetensors`
- `animaInContext`: 既存のadapter/node pack

LLLite node packとweightはGURUGURUへ同梱・自動取得しない。導入・利用前に各配布元とAnima本体のライセンスを確認する。
隔離Composeではユーザー共有modelsをread-onlyのまま保ち、agent固有のINT8本体とLLLite weightを
`guruguru-sandbox_comfy-agent-models` volumeの`diffusion_models/` / `controlnet/`へ置く。
pose-1はPreview3世代のweightで、[配布元model card](https://huggingface.co/kohya-ss/Anima-LLLite)によれば
Anima-Base v1.0派生でも利用できるものの品質低下があり得る。
