# GURUGURU agent sandbox ComfyUI

ローカル GPU と RunPod で共用する ComfyUI イメージです。モデルはイメージに含めず `/models`、
input/output/temp/user は `/data/*` という共通契約にしています。ローカル Compose はモデルだけを
読み取り専用 bind mount し、エージェント追加モデルと生成データはそれぞれ専用 named volume、API は localhost:8288 に限定します。

## 初回セットアップ

PowerShell でリポジトリルートから実行します。

```powershell
Copy-Item sandbox/.env.example sandbox/.env
# sandbox/.env の GURUGURU_MODELS_DIR を実環境に合わせる
docker compose --env-file sandbox/.env -f sandbox/compose.yaml build
docker compose --env-file sandbox/.env -f sandbox/compose.yaml up -d
```

ホスト側GURUGURUは継続作業用のagentランチャーで起動します。

```powershell
bun run start:agent
```

`http://127.0.0.1:5199` を開き、設定の ComfyUI URL を `http://127.0.0.1:8288` にします。
ランチャーは`PORT=5199`、`GURUGURU_INSTANCE_MODE=agent`、リポジトリ外の専用永続data dirを強制します。自動テストは別途`bun run start:test`を使います。

## ローカル検収

```powershell
docker compose --env-file sandbox/.env -f sandbox/compose.yaml ps
bun sandbox/scripts/check-comfy.mjs http://127.0.0.1:8288
# Anima models をマウントした場合は txt2img + inpaint の実生成も確認
bun sandbox/scripts/check-anima.mjs http://127.0.0.1:8288
# 任意: single-reference Anima In-Context の同一 seed smoke
bun sandbox/scripts/check-anima.mjs http://127.0.0.1:8288 C:/path/to/reference.png
```

共通検査は GPU、ComfyUI API、PuLID カスタムノード、Chroma または Anima のモデル候補認識を確認します。
Anima検査はリポジトリの統合Switchパッチャーを通し、512×512・8 stepsのtxt2imgとsynthetic parent/maskのinpaintを確認します。`AnimaLLLiteApply`と`anima-lllite-pose-1.safetensors`が揃う場合はpose ControlNetも実生成し、inpaint weightが揃う場合は4ch LLLite経路を使います。INT8本体とLLLite weightはユーザー共有モデルへ書き込まず、`guruguru-sandbox_comfy-agent-models` volumeの`diffusion_models/`と`controlnet/`へ配置します。
`check-anima.mjs` は production の 8188 へ誤接続しないよう、loopback の 8288 以外を拒否します。

配布ライセンスを確認したうえで、INT8本体はagent model volumeの`diffusion_models/`、LLLite weightは
`controlnet/`へ配置します。既定INT8のSHA-256は`0ecafb8889998fcc4bad2cf38a6e9427e0699718f50c95c8ddf025ecb3223e16`、
inpaint-v2は`5242e677d2be34ee70ca7c97c3b14ff5ee49838c03fc1e60ac4852a180db6ef5`、
pose-1は`ddb543be5e74ce8ca79ae45807aa0c1328a4888e00706727c6fd7100dde7c864`です。

Anima In-Context は任意の実験機能です。スクリプトは `/object_info` から
`AnimaRefEncode`、`AnimaRefLatentBatch`、`AnimaInContextApply` と
`anima-incontext-character.safetensors` の有無を報告します。参照画像を第2引数に渡し、
single-reference に必要な `AnimaRefEncode` / `AnimaInContextApply` と adapter が揃っている場合だけ、
参照元とは異なる固定 seed・ポーズ・背景のターゲットを、参照なし／参照ありの同一条件でA/B生成します。未導入または参照画像省略時は既存の
txt2img / inpaint 検査を維持したまま `inContext.skippedReason` を出力します。

実験する場合は、[Anima-InContext-Character](https://huggingface.co/darask0/Anima-InContext-Character) 配布物の
custom node pack `comfyui-anima-incontext` を隔離テスト用 ComfyUI イメージへだけ導入し、
adapter `anima-incontext-character.safetensors` をagent model volumeの`loras/`に配置します。
adapter は本体 Anima とは別の非商用ライセンスなので、
利用・再配布前に配布元の最新ライセンスを確認してください。参照画像は白背景に近い明瞭なキャラクター画像を使います。
`docker compose down` は各 volume を保持し、`down --volumes` でテスト生成データとエージェント追加モデルも削除します。

## RunPod での同一イメージ利用

同じ Dockerfile から作ったイメージに Network Volume を `/models`、永続 workspace の各ディレクトリを
`/data/input`、`/data/output`、`/data/temp`、`/data/user` へマウントします。GURUGURU の設定 URL を
RunPod 側 URL に変えるだけで切り替えます。将来は Tailscale の private 接続を基本とし、8188 を
インターネットへ直接公開しません。現段階では push、Pod 作成、Tailscale 認証は行いません。

## Fountain から PPTX まで

1. ComfyUI とホストの GURUGURU agent instanceを起動し、モデル検査を通す。
2. B5 縦 Book project を作り、ユーザー支給 Fountain を Script 画面から取り込む。
3. ビート数に合わせた漫画テンプレートでページを作り、各コマを batch 1・長辺約 832px で生成する。
4. Chronicle の一括配置で全セリフを置き、重なりやはみ出しを再配置・個別調整する。
5. PPTX と確認用 PNG を書き出し、PNG をレビューして必要なら生成・配置をやり直す。
6. `Docs/ExperimentLog-AutoManga-YYYY-MM-DD.md` に設定、障害、修正、未解決事項を記録する。
