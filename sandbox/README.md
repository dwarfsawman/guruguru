# GURUGURU test ComfyUI

ローカル GPU と RunPod で共用する ComfyUI イメージです。モデルはイメージに含めず `/models`、
input/output/temp/user は `/data/*` という共通契約にしています。ローカル Compose はモデルだけを
読み取り専用 bind mount し、生成データは専用 named volume、API は localhost:8288 に限定します。

## 初回セットアップ

PowerShell でリポジトリルートから実行します。

```powershell
Copy-Item sandbox/.env.example sandbox/.env
# sandbox/.env の GURUGURU_MODELS_DIR を実環境に合わせる
docker compose --env-file sandbox/.env -f sandbox/compose.yaml build
docker compose --env-file sandbox/.env -f sandbox/compose.yaml up -d
```

ホスト側 GURUGURU は必ずテストランチャーで起動します。

```powershell
bun run start:test
```

`http://127.0.0.1:5199` を開き、設定の ComfyUI URL を `http://127.0.0.1:8288` にします。
ランチャーは `PORT=5199`、`GURUGURU_TEST_DB=1`、リポジトリ外の専用 data dir を強制します。

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
Anima 検査はリポジトリの統合 Switch パッチャーを通し、512×512・8 steps の txt2img と synthetic parent/mask の inpaint が画像出力まで完走することを確認します。
`check-anima.mjs` は production の 8188 へ誤接続しないよう、loopback の 8288 以外を拒否します。

Anima In-Context は任意の実験機能です。スクリプトは `/object_info` から
`AnimaRefEncode`、`AnimaRefLatentBatch`、`AnimaInContextApply` と
`anima-incontext-character.safetensors` の有無を報告します。参照画像を第2引数に渡し、
single-reference に必要な `AnimaRefEncode` / `AnimaInContextApply` と adapter が揃っている場合だけ、
参照元とは異なる固定 seed・ポーズ・背景のターゲットを、参照なし／参照ありの同一条件でA/B生成します。未導入または参照画像省略時は既存の
txt2img / inpaint 検査を維持したまま `inContext.skippedReason` を出力します。

実験する場合は、[Anima-InContext-Character](https://huggingface.co/darask0/Anima-InContext-Character) 配布物の
custom node pack `comfyui-anima-incontext` を隔離テスト用 ComfyUI イメージへだけ導入し、
adapter `anima-incontext-character.safetensors` をホスト側の
`GURUGURU_MODELS_DIR/loras` に配置します。adapter は本体 Anima とは別の非商用ライセンスなので、
利用・再配布前に配布元の最新ライセンスを確認してください。参照画像は白背景に近い明瞭なキャラクター画像を使います。
`docker compose down` は生成用 volume を保持し、`down --volumes` でテスト生成データも削除します。

## RunPod での同一イメージ利用

同じ Dockerfile から作ったイメージに Network Volume を `/models`、永続 workspace の各ディレクトリを
`/data/input`、`/data/output`、`/data/temp`、`/data/user` へマウントします。GURUGURU の設定 URL を
RunPod 側 URL に変えるだけで切り替えます。将来は Tailscale の private 接続を基本とし、8188 を
インターネットへ直接公開しません。現段階では push、Pod 作成、Tailscale 認証は行いません。

## Fountain から PPTX まで

1. ComfyUI とホストの GURUGURU テスト環境を起動し、モデル検査を通す。
2. B5 縦 Book project を作り、ユーザー支給 Fountain を Script 画面から取り込む。
3. ビート数に合わせた漫画テンプレートでページを作り、各コマを batch 1・長辺約 832px で生成する。
4. Chronicle の一括配置で全セリフを置き、重なりやはみ出しを再配置・個別調整する。
5. PPTX と確認用 PNG を書き出し、PNG をレビューして必要なら生成・配置をやり直す。
6. `Docs/ExperimentLog-AutoManga-YYYY-MM-DD.md` に設定、障害、修正、未解決事項を記録する。
