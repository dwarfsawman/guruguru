# Feature: Fountain 自動漫画生成

## 目的

Fountain revision を入力として、脚本の全発話を保持したままページ分割・コマ割り・コマ別画像生成・吹き出し配置・完成ページ書き出しまでを一括実行する。

## 実装

- `src/shared/scriptMangaPlan.ts`: シーン境界を跨がず、既定で最大6要素/2発話を1コマ、4コマを1ページへまとめる決定的プランナー。各コマに画像プロンプトと `dialogue_lines.order_index` を保持する。
- `src/server/scriptMangaDirector.ts`: `planningMode: "llm"` で OpenAI 互換LLMをネーム監督として挿入する。4ページ単位で画角・主役・単一アクション・感情・構図・英語画像プロンプトを構造化JSON化し、コマ数に合う非対称レイアウトも選ぶ。ページ数・コマID・台詞対応はLLMに変更させず、既存の全発話保持保証を維持する。
- `characterBible` を渡すと全バッチの監督プロンプトへ同じ固定票を再注入する。髪型、年齢、体格、服装、固有装備を明記して人物同一性を固定する用途で、未指定時も同名人物の外見固定をLLMへ要求する。
- `planningMode: "provided"` と `directorPlan` で、外部LLMや人間が作ったネームをそのまま実行できる。全台詞orderIndexが重複・欠落なく一度ずつ存在すること、ページ連番、panel id一意、layoutとコマ数、scene範囲を検証してからDBを変更する。
- 比較実験用に `pageLimit` で先頭Nページだけを生成でき、`loras: [{ name, strength }]` は通常の生成と同じChromaモデル専用LoRAチェーンへ渡す。偽文字対策として文字・看板・UI・設定画・分割画面をnegative promptへ明示する。
- `generateImages: false` ではページ・コマ枠・吹き出し・しっぽだけを作り、runを `prepared` にする。GPU生成前にネームをUIで確認するための軽量プレビューモード。
- 追加レイアウトは上段大ゴマ3コマ、右縦大ゴマ3コマ、下段大ゴマ3コマ、下段大ゴマ4コマ、右縦大ゴマ4コマ。均等グリッドだけでなく、導入→反応→決め、追跡、発見の緩急を作れる。同じ3段均等レイアウトの連続を避ける。
- `src/server/scriptManga.ts`: `POST /api/projects/:projectId/script-manga-runs` でページ・コマ・placements・吹き出し・batch=1 の generation rounds を作る。生成長辺は既定1024pxで、`longEdge`(512〜1536)、`steps`、`cfg`、`sampler`、`scheduler` を実行ごとに指定できる。進捗は `script_manga_runs/tasks` に永続化する。
- `GET /api/script-manga-runs/:runId`: round 状態を同期し、完成assetを selected にして対象コマへ割り当てる。ポーリングは冪等。
- 密度の高いページは fontScale=0.68 とseed再探索を使い、全件探索が失敗した場合は2発話ずつへ分割する。通常のChronicle操作はfontScale=1のまま。
- `POST /api/projects/:projectId/pages/:pageId/fit-balloon-text`: 書き出しと同じ折返し幅・形状別内接係数・実フォントbboxで検査し、はみ出す文字だけを最小0.008まで段階的に縮小する。吹き出し位置/大きさ/尻尾は維持する。
- 自動漫画では吹き出し配置直後に `fitPageBalloonText` を実行する。画像生成完了やPPTX書き出しを待たず、ページがUIに現れた時点から文字を内接矩形へ収める。
- 顔アンカー未取得の初期状態でもしっぽを真下固定にせず、右側の吹き出しは左下、左側は右下、中央は発話順に左右交互へ向ける。先端は割当コマの外接矩形から2.5%内側へclampし、隣接コマへ越境させない。画像完成後は従来どおり顔検出した口元アンカーで上書きする。
- Book作成直後の完全に未使用なスターターページ1枚だけを自動実行前に削除する。

## 話者アンカー

全身Poseは顔アップや背面で不適切だった。MediaPipe Face Landmarkerも実生成漫画で0件だったため不採用。`hysts/anime-face-detector` の YOLOv3 + HRNetV2(アニメ顔専用、28 landmarks)を採用し、唇点24〜27の中心を口アンカーにした。

`POST /api/projects/:projectId/pages/:pageId/speaker-anchors` は各コマの画像正規化口座標を受け取り、cropを介してページ座標へ変換する。同じコマの発話順と読書方向に並べた顔を対応させ、吹き出し本体はS5の衝突回避位置に保ったまま尻尾先端を口元へ向ける。顔未検出・低信頼度・thought balloonは変更しない。

尻尾先端は唇へ直接接触させず、顔bboxの長辺28%（page座標で0.012〜0.055にclamp）だけ吹き出し側へ手前で止める。遠景でも最低余白を確保し、大きな顔では過剰に離れない。

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

- 2026-07-11: LLMネーム監督層、キャラクター固定票、非対称の大ゴマレイアウト3種、品質優先の生成パラメーターを追加。
- 2026-07-11: 初期吹き出しの尻尾先端を割当コマ内へ制限し、細い隣接コマへの越境を修正。
- 2026-07-11: 初版。Fountain一括生成API、永続進捗、吹き出し縮小フォールバック、アニメ顔口元アンカーを実装し、全37ページを実生成。
- 2026-07-11: 縦書きの事前サイズ計算と実描画の形状内接係数不一致を修正。全233吹き出しを実bboxで自動フィットし、PNG ZIPを再出力。
- 2026-07-11: しっぽが唇へ接触していたため、顔bbox比例の口元余白を追加。全142本を再アンカーしてPNG ZIPを更新。
