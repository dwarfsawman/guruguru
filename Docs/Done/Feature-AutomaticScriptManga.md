# Feature: Fountain 自動漫画生成

## 目的

Fountain revision を入力として、脚本の全発話を保持したままページ分割・コマ割り・コマ別画像生成・吹き出し配置・完成ページ書き出しまでを一括実行する。

## 実装

- `src/shared/scriptMangaPlan.ts`: シーン境界を跨がず、既定で最大6要素/2発話を1コマ、4コマを1ページへまとめる決定的プランナー。各コマに画像プロンプトと `dialogue_lines.order_index` を保持する。
- `src/server/scriptManga.ts`: `POST /api/projects/:projectId/script-manga-runs` でページ・コマ・placements・吹き出し・batch=1 の generation rounds を作る。生成長辺は768px(約800px)、進捗は `script_manga_runs/tasks` に永続化する。
- `GET /api/script-manga-runs/:runId`: round 状態を同期し、完成assetを selected にして対象コマへ割り当てる。ポーリングは冪等。
- 密度の高いページは fontScale=0.68 とseed再探索を使い、全件探索が失敗した場合は2発話ずつへ分割する。通常のChronicle操作はfontScale=1のまま。
- Book作成直後の完全に未使用なスターターページ1枚だけを自動実行前に削除する。

## 話者アンカー

全身Poseは顔アップや背面で不適切だった。MediaPipe Face Landmarkerも実生成漫画で0件だったため不採用。`hysts/anime-face-detector` の YOLOv3 + HRNetV2(アニメ顔専用、28 landmarks)を採用し、唇点24〜27の中心を口アンカーにした。

`POST /api/projects/:projectId/pages/:pageId/speaker-anchors` は各コマの画像正規化口座標を受け取り、cropを介してページ座標へ変換する。同じコマの発話順と読書方向に並べた顔を対応させ、吹き出し本体はS5の衝突回避位置に保ったまま尻尾先端を口元へ向ける。顔未検出・低信頼度・thought balloonは変更しない。

## 実機結果（2026-07-11）

- 入力: `ALICE_REBOOT_E01_speaker_fixed.fountain`（16 scenes / 644 elements / 233 dialogues）
- 出力: 37 pages / 148 panels / 148 generated assets / failed 0
- GPU: NVIDIA GeForce RTX 4070 SUPER 12GB
- モデル: SDXL Turbo fp16、4 steps、CFG 1、Euler ancestral、batch 1、各コマ長辺768px
- 生成時間: 約3分16秒（全round投入後から完了まで）
- アニメ顔後処理: 479 faces、142 balloon tails更新、errors 0
- 完成PNG ZIP: 37 files (`001.png`〜`037.png`)

## 制約・今後

- 現在の画像プロンプトは日本語Fountain本文をそのまま含むヒューリスティックで、人物同一性・厳密な場面再現は保証しない。今回の受け入れ条件「絵が埋まる」は満たす。
- 同じコマに複数人物がいる場合、顔の本人同定はせず読書方向と発話順で対応する。キャラクター顔参照/identity embeddingとの統合は別フェーズ。
- アニメ顔推論のモデル実行は今回の検証後処理で行った。常設UIから完全自動実行するには、検出sidecarまたはWeb向け変換モデルの配布経路を追加する。

## 変更履歴

- 2026-07-11: 初版。Fountain一括生成API、永続進捗、吹き出し縮小フォールバック、アニメ顔口元アンカーを実装し、全37ページを実生成。
