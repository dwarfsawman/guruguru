# ComfyUI反復的画像探索GUI 仕様書 v0.1

## 1. 概要

本ツールは、ComfyUIを画像生成バックエンドとして利用しながら、ユーザーが「複数候補を生成し、良い画像を選び、その画像を親として次ラウンドを生成する」反復的な画像探索を効率化するための外部GUIアプリケーションである。

ComfyUIのノードグラフは複雑な生成ワークフロー構築に強い一方、実制作では以下の探索ループが重要になる。

1. 16枚前後の画像候補を生成する
2. ユーザーが良い画像を1枚または複数枚選択する
3. 選択画像を親として、img2img、IP-Adapter、ControlNet、seed/prompt再利用などで次の候補群を生成する
4. ラウンドごとの候補、選択、親子関係、設定差分を履歴として管理する
5. 良い枝を後から比較・再生成・派生できるようにする

本仕様では、ComfyUI内のカスタムノードではなく、ComfyUI Server APIを利用する外部GUIとして実装する方針を採用する。

---

## 2. 目的

### 2.1 解決したい課題

現在のComfyUIでは、以下の操作が煩雑になりやすい。

* バッチ生成した複数画像から良い候補を選ぶ
* 選んだ画像だけを次工程に渡す
* txt2img / img2img / IP-Adapter / ControlNet などを素早く切り替える
* seed、prompt、denoise、CFGなどを少しずつ変えながら探索する
* どの画像がどの親画像から派生したかを追跡する
* 過去ラウンドの画像、設定、選択理由を後から確認する
* 生成履歴をラウンド単位・系譜単位で見返す

本ツールは、ComfyUIのgraph-firstな体験ではなく、gallery-first / round-firstな制作体験を提供する。

### 2.2 MVPの目的

MVPでは、以下を実現する。

* ComfyUIと接続できる
* API形式のworkflow JSONテンプレートを読み込める
* 16枚前後の候補画像を生成できる
* 生成結果をギャラリーで比較できる
* 良い画像を1枚または複数枚選択できる
* 選択画像を親として次ラウンドを生成できる
* 親子関係、ラウンド、主要生成パラメータをDBに保存できる
* 過去ラウンドを見返せる
* 任意の候補から再生成・派生生成できる

---

## 3. 非目的

MVPでは以下を対象外とする。

* ComfyUIのノードグラフエディタ自体を再実装すること
* 任意のComfyUI workflowを完全自動解析してGUI化すること
* すべてのカスタムノードに対応すること
* 複数ユーザーの同時共同編集
* クラウドSaaSとしての課金・認証・チーム管理
* 高度なアノテーション、レビュー、コメント機能
* Photoshop的な画像編集機能
* モデル管理、LoRA管理、Checkpointダウンロード管理

ただし、将来的な拡張を妨げないデータ設計にする。

---

## 4. 想定ユーザー

### 4.1 メインユーザー

* ComfyUIを使って画像生成を行う個人クリエイター
* 画像生成モデルを用いてイラスト、写真風画像、キャラクター、コンセプトアートを探索するユーザー
* 1回の生成結果ではなく、複数候補から人間が選びながら方向性を詰めたいユーザー
* ノードグラフの柔軟性は活かしたいが、制作時はギャラリー中心で操作したいユーザー

### 4.2 利用シナリオ

* キャラクターの顔・構図・雰囲気を複数世代にわたって探索する
* ラフなtxt2imgから良い構図を選び、img2imgで精度を上げる
* 良いキャラクター画像をIP-Adapter参照として使い、別ポーズや別シーンを生成する
* ControlNetで構図を維持しながらバリエーションを生成する
* seedやpromptを一部再利用して近い候補を探索する
* 過去に良かった枝を見返して再実行する

---

## 5. 基本コンセプト

本ツールでは、ComfyUIの「node」ではなく、以下の概念を中心に扱う。

### 5.1 Project

1つの制作単位。

例:

* 「日常写真風キャラクター探索」
* 「ブログ用アイキャッチ生成」
* 「漫画キャラクター表情探索」

Projectは複数のGenerationRoundを持つ。

### 5.2 GenerationRound

1回の候補生成単位。

例:

* Round 1: txt2imgで16枚生成
* Round 2: Round 1の候補3番を親にimg2imgで16枚生成
* Round 3: Round 2の候補7番を親にIP-Adapterで16枚生成

各Roundは、使用したWorkflowTemplate、生成プリセット、親Asset、生成されたCandidate群を持つ。

### 5.3 Candidate / Asset

生成された1枚の画像。

Assetには以下を保存する。

* 画像ファイル
* サムネイル
* 所属Project
* 所属Round
* batch内index
* prompt
* negative prompt
* seed
* sampler
* scheduler
* steps
* CFG
* denoise
* model
* LoRA情報
* ControlNet情報
* IP-Adapter情報
* ComfyUI prompt_id
* workflow snapshot hash
* 親Assetとの関係

### 5.4 SelectionEvent

ユーザーが候補を選択・棄却したイベント。

保存する情報:

* どのRoundで選択されたか
* どのAssetが選択されたか
* positive / negative / neutral の種別
* 選択日時
* 選択後に実行された操作
* メモ、任意

### 5.5 AssetParent

画像同士の親子関係。

relation_typeの例:

* `txt2img_origin`
* `img2img`
* `ipadapter_reference`
* `controlnet_reference`
* `seed_reuse`
* `prompt_reuse`
* `manual_reference`
* `upscale`
* `detailer`

これにより、画像の系譜を後から追跡できる。

---

## 6. MVP機能要件

## 6.1 ComfyUI接続

### FR-001: ComfyUI接続設定

ユーザーは、ComfyUI Serverの接続先を設定できる。

設定項目:

* ComfyUI base URL
* WebSocket URL
* タイムアウト秒数
* 画像取得方式
* 保存先ディレクトリ

例:

```text
ComfyUI URL: http://127.0.0.1:8188
WebSocket URL: ws://127.0.0.1:8188/ws
```

### FR-002: 接続確認

ユーザーは「接続テスト」ボタンを押して、ComfyUIと通信できるか確認できる。

確認内容:

* APIに到達できる
* `/object_info` を取得できる
* WebSocket接続が確立できる
* Queue状態を取得できる

画面ヘッダーの接続状態は推測で表示しない。アプリ起動時、設定保存後、接続テスト時に実際の疎通結果を確認し、成功した場合だけ `接続済み` と表示する。未確認、確認中、未接続、生成送信中は別状態として表示する。

### FR-003: 接続エラー表示

接続できない場合、以下を表示する。

* ComfyUIが起動していない可能性
* URLが間違っている可能性
* CORSまたはネットワーク設定の問題
* WebSocket接続失敗
* API応答形式の不一致

ComfyUIへ接続できない状態では、ヘッダーに赤い未接続ステータスを表示する。接続に失敗しているにもかかわらず `接続済み` と表示してはならない。

---

## 6.2 Workflow Template管理

### FR-010: API形式workflow JSONの登録

ユーザーはComfyUIからExportしたAPI形式workflow JSONを登録できる。

登録項目:

* テンプレート名
* 説明
* workflow JSON
* テンプレート種別

  * txt2img
  * img2img
  * IP-Adapter
  * ControlNet
  * Hybrid
* role map

登録UIは常時大きく表示せず、WorkflowTemplateパネルまたは生成サイドバーの `インポート / エクスポート` ドロップダウンから開く。

インポート:

* `.json` ファイルを選択できる
* API形式workflow JSONをtextareaに読み込める
* GURUGURU template形式の場合は、name、description、type、workflowJson、roleMapを復元できる
* 登録時は既存と同じWorkflowTemplate作成APIを使い、versionとworkflow_hashを保存する

エクスポート:

* 選択中WorkflowTemplateのraw workflow JSONを出力できる
* 選択中WorkflowTemplateをGURUGURU template形式で出力できる
* GURUGURU template形式にはname、description、type、version、workflowJson、roleMapを含める

### FR-011: role map設定

テンプレート内のどのノードが何の役割を持つかを設定できる。

role mapの例:

```json
{
  "positive_prompt_node": "6",
  "negative_prompt_node": "7",
  "ksampler_node": "3",
  "seed_input": "3.inputs.seed",
  "cfg_input": "3.inputs.cfg",
  "steps_input": "3.inputs.steps",
  "denoise_input": "3.inputs.denoise",
  "empty_latent_node": "5",
  "batch_size_input": "5.inputs.batch_size",
  "load_image_node": "12",
  "save_image_node": "9"
}
```

MVPでは、完全自動推定ではなく、テンプレートごとのsidecar JSONを用いる。

### FR-012: テンプレートバージョン管理

WorkflowTemplateはバージョンを持つ。

保存項目:

* template_id
* version
* workflow_json
* role_map
* created_at
* updated_at
* workflow_hash

過去に生成されたAssetは、生成時点のtemplate versionとworkflow snapshot hashを保持する。

---

## 6.3 Project管理

### FR-020: Project作成

ユーザーは新規Projectを作成できる。

入力項目:

* Project名
* 説明
* デフォルトWorkflowTemplate
* 保存先
* メモ、任意

### FR-021: Project一覧

Project一覧画面では以下を表示する。

* Project名
* 最終更新日時
* Round数
* Asset数
* 最後に選択された画像サムネイル
* 使用中テンプレート

### FR-022: Project詳細

Project詳細画面では以下を表示する。

* ラウンド一覧
* 最新ラウンドの候補画像
* 選択済み画像
* 系譜ビュー
* 使用テンプレート
* 主要パラメータ

---

## 6.4 生成実行

### FR-030: 新規Round生成

ユーザーはProject内で新規Roundを生成できる。

入力項目:

* WorkflowTemplate
* prompt
* negative prompt
* seed
* seed mode

  * fixed
  * random
  * increment
  * reuse parent seed
* batch size
* steps
* CFG
* sampler
* scheduler
* denoise
* width
* height
* model指定、任意
* LoRA指定、任意

MVPのデフォルトbatch sizeは16とする。

### FR-031: 親Assetから派生生成

ユーザーは既存Assetを選択し、以下の方式で次Roundを生成できる。

* img2imgで次へ
* IP-Adapter参照で次へ
* ControlNet参照で次へ
* 同じseedで再生成
* promptを再利用して再生成
* promptを編集して再生成

### FR-032: 複数親から派生生成

ユーザーは複数Assetを選択して次Roundを生成できる。

MVPでは以下のいずれかに限定する。

* 複数選択したAssetごとに個別Roundを作る
* 複数選択したAssetを同一Round内の参照候補として扱う

初期MVPでは「複数選択したAssetごとに個別Roundを作る」を推奨する。

### FR-033: Workflow JSONパッチ

生成実行時、アプリはWorkflowTemplateをコピーし、role mapに基づいて入力値を差し替える。

差し替え対象:

* prompt
* negative prompt
* seed
* batch size
* steps
* CFG
* sampler
* scheduler
* denoise
* width
* height
* input image
* IP-Adapter reference image
* ControlNet input image
* SaveImage prefix

### FR-034: `/prompt` 送信

パッチ後のworkflow JSONをComfyUIの `/prompt` に送信する。

送信後、ComfyUIから返されるprompt_idをGenerationRoundに保存する。

### FR-035: 進捗取得

WebSocketで以下のイベントを受け取る。

* queue status
* executing node
* progress
* completed
* error
* interrupted

進捗UIには以下を表示する。

* 実行中ステータス
* 現在処理中ノード名
* 進捗バー
* 残りqueue数
* エラー内容

### FR-036: 生成キャンセル

ユーザーは実行中の生成をキャンセルできる。

実装方針:

* ComfyUIの `/interrupt` を呼び出す
* Round statusを `interrupted` にする
* 途中まで生成された画像が取得できる場合は保存する
* 取得できなかった候補は `failed` とする

---

## 6.5 画像取得・保存

### FR-040: `/history` 取得

生成完了後、prompt_idを使って `/history/{prompt_id}` を取得する。

取得する情報:

* 出力画像ファイル名
* subfolder
* type
* node_id
* 実行結果
* エラー情報

### FR-041: `/view` による画像取得

historyから得た画像情報を使って、ComfyUIの `/view` 経由で画像を取得する。

取得後、アプリ側のAsset storageに保存する。

### FR-042: サムネイル生成

保存した画像からサムネイルを生成する。

推奨サイズ:

* small: 256px
* medium: 512px
* large: 1024px

### FR-043: 画像メタデータ保存

Assetごとに主要メタデータを保存する。

必須保存項目:

* prompt
* negative prompt
* seed
* batch index
* workflow template id
* workflow version
* workflow snapshot hash
* prompt_id
* image path
* thumbnail path
* created_at

### FR-044: PNGメタデータ保持

ComfyUIが画像に埋め込んだworkflow metadataは可能な限り保持する。

ただし、検索・表示に使う主要メタデータは外部DBに正規化して保存する。

---

## 6.6 ギャラリーUI

### FR-050: Roundギャラリー表示

Round単位で生成画像をグリッド表示する。制作画面の中心はギャラリーとし、生成画像の比較、選択、拡大、favorite操作をカード上で完結できるようにする。

表示項目:

* サムネイル
* batch index
* seed
* 選択状態
* favorite状態
* 親画像の有無
* 生成方式
* エラー状態

生成画像を取り込んだ後のデフォルト表示は4列 x 4行の16枚グリッドとする。ユーザーは表示密度を4列、3列、2列から切り替えられる。

グリッド生成条件:

* DB上に該当RoundのAssetが存在する場合だけ画像カードのグリッドを作成する
* ComfyUIへ送信しただけ、または生成完了前のRoundでは、選択済みに見えるダミーカードを表示しない
* 生成完了後、`生成結果取得` によってAssetを取り込んだ時点でグリッドを表示する
* 未生成、生成中、未収集、失敗は空状態メッセージとして表示する
* プレースホルダーを使う場合でも、selected/favorite/rejectedなど実データに見える状態を付与してはならない

カード仕様:

* 正方形の画像カードを基本とする
* ホバー時にカードをわずかに浮かせ、アクセント色の枠線を表示する
* 選択中カードはアクセント色の枠線、薄いオーバーレイ、チェックバッジで明示する
* favorite中カードは左上の星バッジを常時表示する
* 拡大表示ボタンを右下に表示する
* batch indexを左下に `#1` の形式で表示する
* 生成中はグリッドカードではなく、生成完了後に取り込む案内を表示する

### FR-051: 画像拡大表示

ユーザーは画像をクリックして拡大表示できる。

拡大表示で見られる情報:

* 画像
* seed
* CFG
* steps
* sampler
* scheduler
* denoise
* prompt
* negative prompt
* 親Asset
* 子Asset
* 使用workflow
* 生成日時

拡大表示は暗い半透明オーバーレイ上のモーダルとし、画像を画面内に最大表示する。下部には主要メタデータの短い表示、選択切替、当該画像からの再生成アクションを置く。

### FR-052: 比較表示

ユーザーは複数画像を選択し、比較表示できる。

MVPでは以下を提供する。

* 2枚比較
* 4枚比較
* 選択中画像のみ表示
* selected / rejected / unmarked のフィルタ

### FR-053: キーボード操作

MVPで対応するショートカット:

* 矢印キー: 画像移動
* Space: 選択切り替え
* Enter: 選択画像から次へ
* Esc: 拡大表示を閉じる
* Ctrl/Cmd + A: 表示中Roundの全選択
* 1〜9: レーティング、任意
* R: reject
* F: favorite

### FR-054: 選択状態

各Candidateは以下の状態を持つ。

* unmarked
* selected
* rejected
* favorite
* archived

MVPでは `selected` と `rejected` を必須とする。

### FR-055: 選択操作バー

Project詳細画面の上部アクションバーに、選択を一括操作するボタンを置く。

操作:

* 全選択
* 選択解除
* 選択反転
* グリッド列数の切り替え

選択数は上部アクションバーと下部アクションバーの両方に表示する。

---

## 6.7 次ラウンド生成UI

### FR-060: 選択画像から次へ

ユーザーは選択したAssetに対して、以下のアクションを実行できる。

* img2imgで次ラウンド
* IP-Adapterで次ラウンド
* ControlNetで次ラウンド
* seed再利用で次ラウンド
* prompt再利用で次ラウンド
* upscale/detailer用テンプレートで処理

### FR-061: 再生成パネル

生成設定は、Project詳細画面の左サイドバーに常時表示する。次ラウンド生成時も同じサイドバー内で以下を編集できる。

* prompt
* negative prompt
* batch size
* steps
* CFG
* denoise
* width
* height
* seed mode
* seed
* sampler
* template
* model / VAE
* 参照強度
* ControlNet strength
* IP-Adapter weight

入力UI:

* promptは常時展開のtextareaとする
* negative promptは折りたたみ可能なtextareaとする
* batch size、steps、CFG、denoise、ループ上限はスライダーと数値表示を併用する
* width / heightは横並びの数値入力とし、入れ替えボタンを置く
* seedはmonospace表示の入力欄とし、ランダムseedボタンとランダムseedチェックを置く
* sampler、workflow、model、VAEはselectで選ぶ

### FR-062: プリセット

ユーザーは再生成設定をプリセットとして保存できる。

プリセット例:

* img2img subtle
* img2img strong
* IP-Adapter character keep
* ControlNet pose keep
* seed variation
* prompt variation
* upscale/detail

### FR-063: 親子関係の保存

次ラウンド生成時、親Assetと子Assetの関係をAssetParentとして保存する。

保存項目:

* parent_asset_id
* child_asset_id
* relation_type
* strength
* preset_id
* created_at

### FR-064: ループ実行バー

Project詳細画面の下部に固定のアクションバーを置き、生成と次ラウンド実行を常に実行できるようにする。

表示項目:

* 選択中画像の小サムネイル列
* 選択中枚数
* 生成中の進捗バー
* `0/16 生成中...` 形式の進捗テキスト

アクション:

* リセット
* 選択画像を保存
* 初回生成 / 再生成
* 選択してループ実行

`選択してループ実行` は選択画像が0枚のとき無効化する。ボタン内には選択枚数バッジを表示する。

---

## 6.8 履歴・系譜ビュー

### FR-070: Round履歴

Project内のRoundを時系列で表示する。

表示項目:

* Round番号
* 生成日時
* 使用テンプレート
* 親Asset
* 生成枚数
* 選択枚数
* メモ
* status

MVPでは、ヘッダー内のイテレーショントラッカーをRound履歴の最小表示として扱う。完了済み、現在、未生成のRoundをドットとコネクタで表現し、各ドットをクリックすると該当Roundを読み込む。

### FR-071: 系譜ビュー

Asset同士の親子関係をツリーまたはグラフで表示する。

MVPでは以下の簡易表示でよい。

* 左から右へ世代表示
* 親画像をクリックすると子画像を表示
* 子画像をクリックすると詳細表示
* 選択済み画像を強調表示

### FR-072: 枝単位の表示

ユーザーは任意のAssetを起点に、その子孫だけを表示できる。

用途:

* 良かった枝だけ追う
* 失敗枝を隠す
* 特定キャラクターの派生だけ見る

---

## 7. 画面仕様

添付HTMLのUIは、ギャラリー中心の作業導線、暗色テーマ、サイドバー構成の参考とする。既存機能を削ったり、実データと紛らわしいダミー状態を持ち込んだりせず、GURUGURUの仕様に合わせて再実装する。16：9のデスクトップ利用を主対象にしつつ、スマートフォンでも閲覧・生成操作ができるレスポンシブUIを想定する。

## 7.0 UIデザイン原則

* ダークテーマを標準とする
* 背景はほぼ黒に近い `#0a0a0f` を基調にする
* アクセント色はviolet系を使い、選択、主要ボタン、進捗、フォーカスに一貫して適用する
* 成功、失敗、生成中の状態は緑、赤、黄のステータスドットで表現する
* パネルは薄い境界線と低透明度の背景を使い、過度な装飾カード化は避ける
* 入力欄、select、slider、buttonは角丸8〜10pxを基準にする
* 画像カードは角丸12pxまで許容する
* 操作ボタンには可能な限りアイコンを併用する
* ラベルは小さめ、値はmonospaceまたは強調色で視認性を上げる
* hover、selected、disabled、generatingの状態を必ず定義する
* スクロールバーもダークテーマに合わせる

## 7.1 Project一覧画面

### 目的

制作プロジェクトを選ぶ。

### 要素

* 新規Project作成ボタン
* Projectカード一覧
* 検索
* 並び替え

  * 最終更新順
  * 作成日順
  * Asset数順
* 各Projectの代表サムネイル

---

## 7.2 Project詳細画面

### 目的

現在の制作状態を確認し、生成・選択・派生を行う。

### レイアウト

Project詳細画面は制作の主画面であり、以下のアプリシェルで構成する。

* 上部: 固定ヘッダー
* 左: 生成設定サイドバー
* 中央: Roundギャラリー
* 中央上部: Round情報と選択操作バー
* 下部: 固定アクションバー
* モーダル: 画像詳細プレビュー
* モバイル: 左サイドバーをドロワー化

### 上部ヘッダー

高さ64pxの固定ヘッダーとする。

表示内容:

* アプリロゴ
* アプリ名 `GURUGURU`
* サブタイトル `Iterative Generation Studio`
* イテレーショントラッカー
* ComfyUI接続ステータス
* 設定ボタン
* モバイル用メニューボタン

イテレーショントラッカー:

* 完了済みRoundは薄いviolet背景のドット
* 現在Roundは塗りつぶしのvioletドット
* 未生成Roundは低コントラストのドット
* 完了済み区間のコネクタはvioletで表示する

接続ステータス:

* 未確認: 低コントラスト
* 確認中: 黄、pulseアニメーション
* 接続済み: 緑
* 未接続: 赤
* 生成送信中: 黄、pulseアニメーション

接続済みは、直近の疎通確認が成功した場合のみ表示する。ComfyUIが起動していない、または設定URLへ接続できない場合は未接続を表示する。

### 左サイドバー

幅320pxを基準とし、画面高からヘッダー高を引いた領域を縦スクロール可能にする。1024px以下では280px程度、768px以下では左から開くドロワーにする。

セクション:

* ワークフロー
* プロンプト
* ネガティブプロンプト
* 生成パラメータ
* ループ設定
* モデル

ワークフロー:

* workflow select
* `Workflow操作` ドロップダウン
* raw workflow export
* GURUGURU template export
* WorkflowTemplate管理画面への導線

Project一覧画面のWorkflowTemplateパネルでは、同じドロップダウンからJSONインポートフォームを開ける。Project詳細サイドバーでは生成作業を邪魔しないよう、エクスポートと管理画面への導線を中心にする。

生成パラメータ:

* バッチサイズ: 4〜32、step 4、default 16
* ステップ数: 1〜50、default 20
* CFGスケール: 1〜20、step 0.5、default 7.0
* デノイズ強度: 0〜1、step 0.05、default 0.60
* 解像度: width / height、step 64、入れ替えボタン付き
* シード: `-1` をランダムとして扱う
* サンプラー: select

ループ設定:

* 選択画像をimg2imgで再生成
* シードバリエーション使用
* プロンプト自動調整
* ループ上限回数: 1〜20、default 10

モデル:

* checkpoint select
* VAE select
* 初期表示では折りたたみ可能とする

### 中央上部アクションバー

ギャラリー上部に現在Roundの状態を表示する。

表示内容:

* `イテレーション #3` のようなRound番号
* `txt2img`、`img2img` などの生成方式タグ
* `16枚生成完了・3枚選択中` のような要約
* 全選択
* 選択解除
* 選択反転
* グリッド列数切り替え

### 中央ギャラリー

生成結果を最も広い領域で表示する。Asset取り込み後のデフォルトは4列グリッド、gapは小さめにし、画像密度を優先する。

Assetが存在しないRoundでは、画像カードのグリッドを作らない。未生成、生成中、未収集、失敗の状態を明確な空状態メッセージとして表示する。

画像カード:

* 正方形
* サムネイルは `object-fit: cover`
* hover時に拡大率を少しだけ上げる
* 選択バッジ、favoriteバッジ、拡大ボタン、batch indexをオーバーレイ表示する
* favoriteバッジと選択バッジはカード内でクリックでき、カード本体クリックは選択切替とする

### 下部アクションバー

画面下部に固定し、生成作業中に常に見えるようにする。

左側:

* 生成中進捗
* 選択中画像の小サムネイル
* 選択枚数の説明

右側:

* リセット
* 保存
* 初回生成 / 再生成
* 選択してループ実行

生成送信中は進捗表示、生成完了後かつAsset取り込み後は選択情報を主表示に戻す。

### 主要アクション

* 新規Round生成
* 選択画像から次へ
* 選択画像を比較
* 選択画像をfavorite
* 選択画像をreject
* Roundを複製
* Roundを再実行
* 選択画像を保存
* すべてのイテレーション履歴をリセット

---

## 7.3 画像詳細モーダル

### 表示内容

* 大きな画像プレビュー
* 親画像
* 子画像一覧
* prompt
* negative prompt
* seed
* CFG
* steps
* denoise
* sampler
* workflow template
* 生成日時
* ファイルパス

### レイアウト

* 背景は黒の半透明オーバーレイとblur
* 画像は最大 `85vw` / `85vh` を目安に表示する
* 閉じるボタンを右上に置く
* 下部左に主要メタデータを1行で表示する
* 下部右に選択切替と再生成アクションを置く

### アクション

* selectedにする
* rejectedにする
* favoriteにする
* img2imgで次へ
* IP-Adapterで次へ
* ControlNetで次へ
* seed再利用
* promptコピー
* ComfyUI用workflowをエクスポート

---

## 7.4 生成設定パネル

生成設定パネルはProject詳細画面の左サイドバーとして扱う。

### 入力欄

* prompt
* negative prompt
* batch size
* seed mode
* seed
* width
* height
* steps
* CFG
* denoise
* sampler
* scheduler
* template
* preset

### アクション

* 生成開始
* 設定をプリセット保存
* 前回設定を読み込み
* 親Assetの設定を読み込み
* ランダムseedに変更

### レスポンシブ

* 768px以下ではサイドバーを画面外に隠し、ヘッダーのメニューボタンで開閉する
* サイドバー表示中は半透明オーバーレイを表示し、オーバーレイクリックで閉じる
* 下部アクションバーは折り返しを許容し、主要アクションが画面外に消えないようにする
* ギャラリー列数は画面幅に応じて2〜4列を選択できる

---

## 8. データモデル案

## 8.1 Project

```text
Project
- id
- name
- description
- default_template_id
- created_at
- updated_at
```

## 8.2 WorkflowTemplate

```text
WorkflowTemplate
- id
- name
- description
- type
- version
- workflow_json
- role_map_json
- workflow_hash
- created_at
- updated_at
```

## 8.3 GenerationRound

```text
GenerationRound
- id
- project_id
- template_id
- parent_round_id
- round_index
- prompt_id
- status
- generation_mode
- preset_id
- request_json
- patched_workflow_json
- created_at
- completed_at
```

status:

* pending
* running
* completed
* failed
* interrupted

generation_mode:

* txt2img
* img2img
* ipadapter
* controlnet
* seed_reuse
* prompt_reuse
* upscale
* detail

## 8.4 Asset

```text
Asset
- id
- project_id
- round_id
- prompt_id
- batch_index
- image_path
- thumbnail_small_path
- thumbnail_medium_path
- width
- height
- prompt
- negative_prompt
- seed
- sampler
- scheduler
- steps
- cfg
- denoise
- model_name
- workflow_template_id
- workflow_template_version
- workflow_snapshot_hash
- comfy_output_node_id
- status
- rating
- created_at
```

status:

* generated
* selected
* rejected
* favorite
* archived
* failed

## 8.5 AssetParent

```text
AssetParent
- id
- parent_asset_id
- child_asset_id
- relation_type
- strength
- preset_id
- created_at
```

relation_type:

* img2img
* ipadapter_reference
* controlnet_reference
* seed_reuse
* prompt_reuse
* upscale
* detailer
* manual

## 8.6 SelectionEvent

```text
SelectionEvent
- id
- project_id
- round_id
- asset_id
- action
- note
- created_at
```

action:

* select
* unselect
* reject
* unreject
* favorite
* unfavorite

## 8.7 GenerationPreset

```text
GenerationPreset
- id
- name
- description
- generation_mode
- template_id
- params_json
- created_at
- updated_at
```

---

## 9. アーキテクチャ

## 9.1 全体構成

```text
[Frontend GUI]
  |
  | HTTP / WebSocket
  v
[App Backend / Orchestrator]
  |
  | ComfyUI Server API
  v
[ComfyUI Server]
  |
  v
[Models / Custom Nodes / Workflows]

[App Backend]
  |
  +-- DB
  +-- Image Storage
  +-- Thumbnail Storage
```

## 9.2 Frontend

推奨:

* TypeScript
* ReactまたはVue
* SPA構成

主な責務:

* Project / Round / Asset表示
* ギャラリーUI
* 選択UI
* 生成設定UI
* 系譜ビュー
* WebSocket進捗表示

## 9.3 Backend

推奨:

* Python
* FastAPI
* SQLiteまたはPostgreSQL
* Pillowによるサムネイル生成
* ComfyUI API client

主な責務:

* WorkflowTemplate管理
* workflow JSONパッチ
* ComfyUIへの `/prompt` 送信
* WebSocketイベント中継
* `/history` 取得
* `/view` 画像取得
* 画像保存
* メタデータ保存
* 親子関係保存

## 9.4 Storage

MVPではローカルファイル保存でよい。

推奨ディレクトリ構造:

```text
data/
  projects/
    {project_id}/
      assets/
        original/
        thumbnails/
      workflows/
      exports/
  app.db
```

将来的にはS3互換ストレージに差し替え可能にする。

---

## 10. ComfyUI連携仕様

## 10.1 使用するComfyUI API

使用予定API:

* `GET /object_info`
* `POST /prompt`
* `GET /history/{prompt_id}`
* `GET /view`
* `POST /upload/image`
* `GET /queue`
* `POST /interrupt`
* `WebSocket /ws`

## 10.2 生成実行フロー

```text
1. ユーザーが生成ボタンを押す
2. BackendがWorkflowTemplateを取得
3. role mapに基づいてworkflow JSONをパッチ
4. GenerationRoundをDBに作成
5. ComfyUI `/prompt` に送信
6. prompt_idを保存
7. WebSocketで進捗を受信
8. 完了後 `/history/{prompt_id}` を取得
9. `/view` で画像を取得
10. 画像とサムネイルを保存
11. AssetをDBに作成
12. 親Assetがある場合はAssetParentを作成
13. FrontendにRound完了を通知
```

## 10.3 img2img実行フロー

```text
1. ユーザーが親Assetを選択
2. 「img2imgで次へ」を押す
3. Backendが親画像をComfyUIに `/upload/image` する
4. img2img用WorkflowTemplateを取得
5. load image nodeにアップロード画像名を設定
6. denoiseなどの値を設定
7. `/prompt` に送信
8. 子Asset生成後、AssetParentをrelation_type=img2imgで保存
```

## 10.4 IP-Adapter実行フロー

```text
1. ユーザーが親Assetを選択
2. 「IP-Adapterで次へ」を押す
3. 親画像をComfyUIに `/upload/image` する
4. IP-Adapter用WorkflowTemplateを取得
5. 参照画像ノードに親画像を設定
6. weightなどの値を設定
7. `/prompt` に送信
8. 子Asset生成後、AssetParentをrelation_type=ipadapter_referenceで保存
```

## 10.5 ControlNet実行フロー

```text
1. ユーザーが親Assetを選択
2. 「ControlNetで次へ」を押す
3. 親画像または前処理画像をComfyUIに `/upload/image` する
4. ControlNet用WorkflowTemplateを取得
5. ControlNet入力ノードに画像を設定
6. strengthなどの値を設定
7. `/prompt` に送信
8. 子Asset生成後、AssetParentをrelation_type=controlnet_referenceで保存
```

---

## 11. エラー処理

## 11.1 ComfyUI接続エラー

表示メッセージ例:

```text
ComfyUIに接続できません。
ComfyUIが起動しているか、URLが正しいか確認してください。
```

## 11.2 workflow JSON不正

表示メッセージ例:

```text
WorkflowTemplateの形式が不正です。
API形式でExportされたworkflow JSONか確認してください。
```

## 11.3 role map不一致

表示メッセージ例:

```text
WorkflowTemplate内に指定されたnode idが見つかりません。
role mapを確認してください。
```

## 11.4 生成失敗

表示項目:

* エラー発生node
* エラーメッセージ
* prompt_id
* 再実行ボタン
* workflow JSON確認ボタン

## 11.5 画像取得失敗

表示メッセージ例:

```text
生成は完了しましたが、画像の取得に失敗しました。
ComfyUIのhistoryまたはoutput directoryを確認してください。
```

---

## 12. MVP受け入れ基準

MVPは以下を満たしたら完了とする。

### 接続

* ComfyUI Server URLを設定できる
* 接続テストが成功する
* `/object_info` を取得できる
* WebSocketで進捗を受信できる

### テンプレート

* API形式workflow JSONを登録できる
* role mapを設定できる
* txt2imgテンプレートを使って生成できる
* img2imgテンプレートを使って親画像から生成できる

### 生成

* 16枚の候補画像を生成できる
* 生成中の進捗が表示される
* 生成完了後、画像がギャラリーに表示される
* 生成結果がDBとファイルストレージに保存される

### 選択

* 画像をselectedにできる
* 画像をrejectedにできる
* 選択状態が永続化される
* 選択画像だけをフィルタ表示できる

### 派生

* 選択画像からimg2imgで次Roundを生成できる
* 親Assetと子Assetの関係が保存される
* Round履歴で派生関係を確認できる

### 履歴

* Project内のRound一覧を見られる
* 過去Roundの画像を見返せる
* Asset詳細で主要パラメータを確認できる
* 親画像・子画像を確認できる

---

## 13. 推奨MVP開発順序

### Phase 1: ComfyUI接続と単発生成

* ComfyUI接続設定
* workflow JSON登録
* role map設定
* `/prompt` 実行
* `/history` 取得
* `/view` 画像取得
* 画像保存

### Phase 2: Project / Round / Asset管理

* Project作成
* Round作成
* Asset保存
* ギャラリー表示
* サムネイル生成

### Phase 3: 選択UX

* selected / rejected
* 拡大表示
* 比較表示
* キーボード操作
* フィルタ表示

### Phase 4: 派生生成

* 親Asset選択
* img2imgテンプレート対応
* `/upload/image`
* AssetParent保存
* Round履歴表示

### Phase 5: 系譜ビュー

* 親子関係表示
* 枝単位表示
* 選択済み枝の強調
* 再生成導線

---

## 14. 将来拡張

### 14.1 高度な探索管理

* 複数親から1つのRoundを生成
* 良い画像と悪い画像を分けたpositive / negative selection
* レーティング
* タグ
* メモ
* 類似画像検索
* CLIP embedding検索

### 14.2 Workflow連携

* 複数テンプレートのチェーン実行
* upscale/detailer専用Round
* ComfyUI workflow再エクスポート
* ComfyUI画像メタデータからProjectへインポート

### 14.3 UI拡張

* A/B比較
* 世代別タイムライン
* 画像の重ね比較
* prompt差分表示
* seed差分表示
* パラメータ別フィルタ

### 14.4 運用拡張

* PostgreSQL対応
* S3互換ストレージ対応
* マルチユーザー対応
* Queue管理
* 複数ComfyUI worker対応
* リモートGPU対応

---

## 15. 実装上の注意

### 15.1 ComfyUIフロントエンド拡張に依存しない

本ツールのコアUXは外部GUI側に持つ。

ComfyUI側には以下のみを期待する。

* workflow実行
* 画像生成
* history提供
* image view
* image upload
* WebSocket進捗通知

ComfyUIのフロントエンド内部状態やカスタムノードのモーダルUIには依存しない。

### 15.2 workflow JSONの汎用解析を頑張りすぎない

MVPでは、任意workflowを完全にGUI化しようとしない。

代わりに、以下の方式を採用する。

* 少数の定型テンプレートを用意する
* テンプレートごとにrole mapを持つ
* node idとinput pathを明示的に指定する
* 実行時は値だけを安全に差し替える

### 15.3 PNGメタデータだけに頼らない

ComfyUIのPNG埋め込みmetadataは保持するが、探索履歴の主データにはしない。

理由:

* 検索しにくい
* 親子関係を表現しにくい
* 複数Roundの管理に向かない
* batch内の個別候補管理に弱い

主要パラメータと親子関係は外部DBに保存する。

### 15.4 生成単位はRound、画像単位はAsset

UIもDBもAPIも、RoundとAssetを中心に設計する。

ComfyUIのprompt_idは外部生成ジョブIDとして扱い、アプリ側の主キーにはしない。

---

## 16. 初期プリセット案

### txt2img_16grid

用途:

* 最初のラフ探索
* 構図探索
* 雰囲気探索

デフォルト:

```text
batch size: 16
steps: 20
cfg: 4.5〜7
seed: random
```

### img2img_subtle_16grid

用途:

* 良い画像をあまり崩さず微修正

デフォルト:

```text
batch size: 16
denoise: 0.25〜0.40
seed: random
```

### img2img_strong_16grid

用途:

* 親画像の構図を残しつつ大きく変える

デフォルト:

```text
batch size: 16
denoise: 0.55〜0.75
seed: random
```

### ipadapter_character_16grid

用途:

* キャラクター性を維持して別構図を生成

デフォルト:

```text
batch size: 16
ip-adapter weight: 0.5〜0.8
seed: random
```

### controlnet_pose_16grid

用途:

* ポーズや構図を維持して生成

デフォルト:

```text
batch size: 16
controlnet strength: 0.5〜0.8
seed: random
```

---

## 17. 最小UIワイヤーフレーム

```text
+--------------------------------------------------------------------------------+
| GURUGURU  Iterative Generation Studio      1 -- 2 -- [3] -- 4   ● ComfyUI OK   |
+------------------------------+-------------------------------------------------+
| Workflow                     | Iteration #3  [txt2img]                         |
| [txt2img_standard.json v]    | 16枚生成完了・3枚選択中        [全選択][解除][反転][4x4 v] |
| [Workflow操作 v]             +-------------------------------------------------+
|                              |                                                 |
| Prompt                       | [#1 ] [#2 ] [#3*] [#4 ]                         |
| [textarea                 ]  | [#5 ] [#6 ] [#7*] [#8 ]                         |
|                              | [#9 ] [#10] [#11*][#12]                         |
| Negative Prompt [v]          | [#13] [#14] [#15] [#16]                         |
|                              |                                                 |
| Generation Parameters        | 画像カード: hover枠、選択チェック、favorite星、拡大ボタン |
| Batch [----16-------]        |                                                 |
| Steps [----20-------]        +-------------------------------------------------+
| CFG   [----7.0------]        | 選択サムネイル: (3)(7)(11)   3枚を次に使用      |
| Denoise [--0.60-----]        | [リセット] [保存] [初回生成/再生成] [選択してループ実行 3] |
| Width [512] <swap> [768]     +-------------------------------------------------+
| Seed  [-1] [random]          |
| Sampler [dpmpp... v]         |
|                              |
| ループ設定                   |
| [x] 選択画像をimg2imgで再生成 |
| [ ] シードバリエーション     |
| [ ] プロンプト自動調整       |
| Max loop [----10------]      |
+------------------------------+

Mobile:
+------------------------------------------------+
| [menu] GURUGURU         1 -- [2]     ● OK      |
+------------------------------------------------+
| Iteration #2  [txt2img]              [2列 v]   |
| [#1] [#2]                                      |
| [#3] [#4]                                      |
| ...                                            |
+------------------------------------------------+
| 選択サムネイル     [生成] [ループ]             |
+------------------------------------------------+
| メニュー開: 左ドロワー + 暗いオーバーレイ     |
+------------------------------------------------+
```

---

## 18. 成功指標

MVPの成功は、以下で判断する。

* ユーザーがComfyUIのノードを触らずに、16枚生成→選択→次ラウンド生成を繰り返せる
* 画像の親子関係を後から見返せる
* 良い候補の枝を見失わない
* txt2imgからimg2imgへの移行が数クリックでできる
* seed、prompt、denoiseなどの再利用が簡単にできる
* 生成画像と主要パラメータがDBに残る
* ComfyUI側のworkflow再現性も維持される

---

## 19. 最終方針

本ツールは、ComfyUIの代替ではなく、ComfyUIの上に乗る探索UIである。

ComfyUIは引き続き以下を担当する。

* モデル実行
* ノードグラフによる生成処理
* カスタムノード資産の利用
* workflow実行環境

本ツールは以下を担当する。

* 候補画像の比較
* 人間による選択
* ラウンド管理
* 親子関係管理
* 探索履歴管理
* 再生成プリセット
* gallery-firstな制作体験

したがって、プロダクトの核は「画像を生成すること」ではなく、「人間が良い画像を選びながら探索を進めること」である。
