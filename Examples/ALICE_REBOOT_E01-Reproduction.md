# ALICE REBOOT E01 漫画生成・再現条件

## 結果

2026-07-12に[`ALICE_REBOOT_E01.fountain`](ALICE_REBOOT_E01.fountain)を、GURUGURUのMangaPlan V2と隔離ComfyUIで一から漫画化した実機例です。既存漫画画像の再利用はしていません。

- 85ページ、233コマ、元台詞233件
- 右開き、縦書き日本語吹き出し
- 最終ページは2048×2892px
- 生成233件成功、失敗0
- PNG 85ページ、PPTX 85スライド、OpenRaster 85ページを書き出して検証

実機生成で使用した承認済みMangaPlanは[`ALICE_REBOOT_E01-manga-plan.json`](ALICE_REBOOT_E01-manga-plan.json)として収録しています。全85ページ・233コマの英語prompt、cast、元台詞との対応、レイアウトが含まれます。生成画像、選択済みアセット、キャラクター参照、seed、workflow snapshotは含めません。

## 最終的に完走した生成条件

| 項目 | 値 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4070 SUPER、12GB VRAM |
| ComfyUI | `sandbox/compose.yaml`による隔離Docker、localhost:8288 |
| GURUGURU | test DB、リポジトリ外test data dir、非5177ポート |
| ベースモデル | Chroma natural系 |
| パネル解像度 | 長辺1024px、コマのアスペクト比を維持 |
| Steps / CFG | 20 / 4.5 |
| Sampler / Scheduler | `dpmpp_2m` / `simple` |
| Batch / 同時送信 | 1 / 1 |
| 最大試行 | 1コマ3回 |
| 顔参照 | PuLID-Flux + InsightFace `antelopev2` |
| Style LoRA | なし |
| 監査／採用 | `auditMode: "manual"`、候補を人間reviewで採用 |

PuLIDとStyle LoRAの併用は12GB環境でCUDAメモリ不足になったため、人物同一性を優先してPuLIDだけを残しました。LM Studioを使う場合も、ネーム・prompt作成の完了後にモデルをunloadし、ComfyUIと同時常駐させません。

InsightFaceの自動取得が`models/insightface/models/antelopev2/antelopev2/*.onnx`という二重ディレクトリになる場合は、`.onnx`を一段上の`antelopev2/`へ移してから隔離ComfyUIを再起動します。

## 画作りとprompt規約

- 高コントラストのSF漫画、インク線、スクリーントーンを共通画風にする。
- 基本はモノクロとし、赤・青などを限定的なアクセントにする。
- 画像生成promptは英語に統一し、日本語台詞や表示文字を入れない。
- 台詞、コマ枠、吹き出し、縦書きは生成後にGURUGURUで合成する。
- 各promptは「共通画風 → 登場人物と外見ロック → 場所／時刻 → 動作と表情 → カメラ → 光 → 連続性 → 禁止事項」の順で組む。
- PuLIDだけに依存せず、年齢、髪、顔立ち、衣装、傷、汚れ、装備、身体状態を各コマの英語promptにも明記する。
- 通信、機械音声、表示、録音など、画面に存在しない話者はcastから外す。

## キャラクター固定

成人アリス、10代アリス、ミラ、志堂、カイン、赤の女王について、新規キャラクターシートをComfyUIで生成し、目視選定した顔をPuLID参照にしました。同一人物の派生話者は同じ参照へ束ねます。

- ミラとミラV.O.
- カインと通信越しのカイン
- 志堂と記録映像の志堂

成人アリスと10代アリスは別の人物参照として扱います。通信、機械、ディスプレイ、録音そのものには人物参照を割り当てません。

## 人間またはLocal LLMが担う工程

今回の実機例では、通常は人間スタッフやLM StudioのLocal LLMへ委任する次の作業をCodexとサブエージェントが担当しました。

### 脚本解析と構成

- Fountainのscene、action、speaker、dialogueを解析する。
- V.O.、通信、録音、機械音声、同一人物の別表記を正規化する。
- 時系列、回想、現在場面、人物関係、情報開示順を整理する。
- 全台詞を85ページ・233コマへ割り当て、欠落と重複を照合する。
- ページ送り、見せ場、無言コマ、会話テンポ、コマサイズと配置を設計する。

これは脚本家、編集者、ネーム担当、または構成用Local LLMの仕事に相当します。

### Prompt compiler

- 233コマすべての状況を、画像として生成可能な英語promptへ変換する。
- カメラ、画角、人物位置、動作、表情、背景、光源を具体化する。
- 外見ロックと前後コマの衣装・傷・装備・場所の連続性を注入する。
- 画面外話者の誤描画と画像内の偽文字を防ぐ。

これは通常、LM StudioなどのLocal LLMによるprompt compiler工程です。

### キャスト修正とキャラクター参照選定

- V.O.や通信を別人物として扱う誤りを修正する。
- 成人版／10代版アリスを分け、同一人物の派生話者を束ねる。
- 新規キャラクターシートを比較し、年齢、顔、役柄に合うPuLID参照を選ぶ。

これはキャラクターデザイナー、人間review、またはVLM審査に相当します。

### 候補採用と最終検品

- 代表生成で画風、人物参照、構図、吹き出し余白、CUDA安定性を確認する。
- 完成候補を採用し、失敗taskを監視する。
- 全233コマ、全85ページ、解像度、破損、PPTX／ORAページ数を検査する。
- 冒頭、1/4、中盤、3/4、最終ページを目視確認する。

これは人間の作画監督・編集・校正、またはVLM監査に相当します。本例ではVLM自動採点を使わず、代表ページの目視確認と決定論的な全件検査を組み合わせました。

## 再実行時の順序

1. `sandbox/README.md`に従い、隔離ComfyUIを8288で起動する。
2. GURUGURUを`GURUGURU_TEST_DB=1`、リポジトリ外の`GURUGURU_TEST_DATA_DIR`、非5177ポートで起動する。
3. Fountainを取り込み、主要人物のキャラクターシートとPuLID参照を新規作成する。
4. Local LLMまたは人間が全編のネーム、cast、英語prompt、外見ロックを完成させる。
5. 元台詞233件、85ページ、233コマの対応関係とvalidation warning/errorを確認する。
6. LM Studioのモデルをunloadする。
7. 上記のComfyUI条件でbatch 1・同時送信1として生成する。
8. 候補をreviewして採用し、失敗taskのみ最大3回までretryする。
9. PNG、PPTX、ORAへ書き出し、85ページと解像度を検査する。

## 再現性の境界

MangaPlan、英語prompt、cast、キャラクター参照、workflow、checkpoint、seedをすべて保存すればピクセル再現性を高められます。このExampleには承認済みMangaPlanを同梱していますが、キャラクター参照、workflow、checkpointの正確なhash、seed、採用アセットは含まれません。そのため再現できるのは同じ構成・演出・prompt・castであり、完成画像のピクセル完全一致ではありません。

恒久的に再現する案件では、次をリポジトリ外の案件保管領域へまとめてください。

- Fountain原稿のrevision
- 承認済みMangaPlan JSON
- checkpoint／LoRA／PuLID／InsightFaceの正確なファイル名とhash
- キャラクター参照画像と対応表
- ComfyUI API workflow JSON
- 各taskのseed、prompt、negative prompt、生成パラメーター
- 採用asset IDと書き出し成果物のSHA-256
