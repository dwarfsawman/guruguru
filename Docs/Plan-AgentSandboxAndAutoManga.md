# 計画: テスト用 ComfyUI コンテナ + 自動漫画生成実験

作成: 2026-07-11。更新: 2026-07-11。ステータス: **P0〜P2 完了**。

## 1. 方針

Codex GUI、GURUGURU、Git はホスト上で動かす。エージェント専用 dev コンテナや egress firewall は
採用せず、GURUGURU の既存テスト環境分離を使う。コンテナ化するのは ComfyUI のみとし、同じ
イメージをローカル GPU と将来の RunPod で利用する。

守るべき規則:

- GURUGURU は `PORT=5199`（5177 以外）、`GURUGURU_TEST_DB=1`、リポジトリ外の
  `GURUGURU_TEST_DATA_DIR` で起動する。
- 本番 GURUGURU データ、本番 ComfyUI の `/history`・`/view`、本番 input/output へアクセスしない。
- ローカル ComfyUI は `127.0.0.1:8288`、専用 input/output/temp/user を使う。
- ホストの既存 models ルートだけを `/models` に read-only mount する。モデルはイメージに含めない。
- RunPod では Network Volume を同じ `/models` に mount する。将来の接続は Tailscale を基本とし、
  ComfyUI API を不用意に公開しない。

## 2. 実装構成

`sandbox/` に次を置く。

- `comfyui/Dockerfile`: CUDA 12.8.1、Python 3.11、PyTorch cu128、ComfyUI と
  `PaoloC68/ComfyUI-PuLID-Flux-Chroma` を commit 固定して導入。
- `compose.yaml`: GPU、localhost:8288、models read-only、専用 named volumes、healthcheck。
- `scripts/check-comfy.mjs`: GPU、API、PuLID node、Chroma/encoder/VAE のモデル認識を検査。
- `README.md`: ローカル起動、URL 切替、RunPod mount 契約、実験手順。

ホスト側は `bun run start:test` を安全ランチャーとする。ランチャーは build 後、テスト DB と外部
data dir を強制し、5177 を拒否する。

## 3. 固定バージョン

| 要素 | 固定値 |
| --- | --- |
| CUDA runtime | `12.8.1-cudnn-runtime-ubuntu24.04` |
| Python | `3.11` (`uv` managed) |
| PyTorch wheel channel | `cu128` |
| ONNX Runtime GPU | `1.22.0`（CUDA 12 対応） |
| ComfyUI | `f3a36e74844893f32f77f22d249d08862805d8f4` |
| PuLID Flux Chroma fork | `52dc5068e0fc304e51273cfa5fbdd031e1ddb824` |

Python requirements は上記 commit の requirements を解決してイメージに封入する。モデルと生成物は
封入しない。

## 4. ローカル完了条件

1. Compose の静的設定が妥当である。
2. Docker Desktop WSL2 の NVIDIA runtime から RTX 4070 SUPER を認識する。
3. ComfyUI が localhost:8288 で healthy になる。
4. PuLID custom node が `/object_info` に登録される。
5. `/models` が read-only、input/output/temp/user が専用 volume である。
6. Chroma 本体、text encoder、VAE が ComfyUI の選択肢として認識される。
7. GURUGURU を 5199 + test DB + 外部 test data dir で起動し、設定 URL を 8288 にできる。
8. 可能なら 512×288、6 steps、batch 1 の低負荷 txt2img を完走する。

モデルチェックやスモーク生成が現行モデル名・workflow の追加指定を必要とする場合は、未検証項目と
して明記し、本番 ComfyUI を代用しない。

## 5. Fountain から PPTX までの一発実験

前提はユーザー支給 Fountain、Noto Sans CJK JP、ローカル ComfyUI のモデル検査成功。本番 ComfyUI
は使用しない。

1. `bun run start:test` でホスト GURUGURU を起動し、ComfyUI URL を 8288 にする。
2. B5 縦 Book project を作り Fountain を取り込む。
3. ビート数と見せ場に合わせてページ・コマ割りを作る。
4. Chroma + style LoRA、batch 1、長辺約 832px、低〜中 steps で各コマを生成・割当する。
5. Chronicle 一括配置で全セリフを配置し、はみ出しと重なりを調整する。
6. PPTX と確認用 PNG を出力し、PNG を自己レビューして修正する。
7. `Docs/ExperimentLog-AutoManga-2026-07-XX.md` に設定、障害、原因、修正、製品化所見を残す。

成功基準は、支給脚本の全セリフと全コマ画像を含むページが PPTX で出力されること。PuLID はまず
人物タグ + LoRA で一周完成後、主要人物だけ二周目で試す。

## 6. URL 切替と RunPod

- ローカル: `http://127.0.0.1:8288`
- RunPod: 将来 Tailscale で到達できる private URL

GURUGURU の設定画面/API で URL のみを変更する。RunPod では Network Volume `/models` と永続領域
`/data/*` を同じ契約で mount する。現フェーズでは registry push、Pod 作成、課金、Tailscale 認証は
行わない。

## 7. フェーズ

| フェーズ | 内容 | 状態 |
| --- | --- | --- |
| P0 | Docker/GPU/models root 確認 | 完了 |
| P1 | 共用 ComfyUI image + local Compose | 完了 |
| P2 | ホスト test launcher + health/model check + 手順 | 完了 |
| P3 | Fountain → PPTX 実験と障害ログ | 脚本受領後 |
| P4 | RunPod/Tailscale 実投入 | 保留（課金・認証前に確認） |
| P5 | 自動コマ割り・prompt・一括進行の製品化 | P3 後に再計画 |

## 8. 2026-07-11 検証結果

- Docker Desktop 4.81 / NVIDIA runtime で RTX 4070 SUPER (12GB) を認識。
- ComfyUI 0.27.0、PyTorch 2.11.0+cu128、Python 3.11.15 が localhost:8288 で healthy。
- PuLID の4 node（loader 3種 + apply）を登録。`onnxruntime-gpu 1.27` が CUDA 13 を要求する互換性問題を検出し、CUDA 12 対応の 1.22.0 に固定して解消。
- models mount は read-only、input/output/temp/user は専用 named volume であることを Docker inspect で確認。
- GURUGURU の `model-check?family=chroma` で VAE、Chroma、T5、ControlNet、PuLID と必須 node が全て available。
- `bun run start:test` が port 5199、test DB、`%LOCALAPPDATA%\\GURUGURU-CODEX-TEST` で起動し `/api/health` 成功。
- `bun run typecheck`、`bun run build`、`bun test`（716件）、`git diff --check` 成功。
- 未検証: 実画像を生成する 512×288 / 6 steps smoke。P3 の支給脚本・workflow 選定時に、専用 output volume へ生成して確認する。

## 変更履歴

- 2026-07-11: 強いエージェント隔離案を廃止。ホスト GURUGURU テスト環境 + ComfyUI 単体コンテナへ変更。
- 2026-07-11: 初版。dev + ComfyUI のフル compose 案と自動漫画一発実験を策定。
