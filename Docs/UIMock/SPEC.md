# GURUGURU UIモック共通仕様(A/B比較用)

全提案(A〜D)はこの仕様に**厳密に**従う。デザイン(色・タイポ・形状・質感・レイアウト言語)だけが案ごとに異なり、
**画面構成・要素・ダミーデータは全案で完全に同一**とする。そうでないと公平な比較にならない。

## 成果物

- 各案 1ファイル: `Docs/UIMock/<KEY>/mock.html`(KEY = A / B / C / D)
- **完全自己完結**: 外部リソース参照ゼロ(http/https のURL、外部フォント、外部画像すべて禁止。
  使用可能なのはインラインCSS / インラインJS / インラインSVG / data: URI のみ)
- フォントはシステムフォントスタックのみ(例: `Inter, ui-sans-serif, system-ui, "Segoe UI", "Yu Gothic UI", sans-serif`、
  等幅は `ui-monospace, Consolas, monospace`)
- ボタン・入力は**見た目のみ**(機能不要)。ただしhover状態のCSSはあると良い
- 全カラーは `:root` の CSS変数で定義する(現行 `src/client/styles.css` の変数名 `--bg --panel --panel-strong
  --line --ink --muted --faint --accent --accent-strong --accent-soft --good --warn --danger` を踏襲し、
  必要なら追加)。当選案を実CSSへ移植しやすくするため

## 画面切替とスクリーンショット対応(必須)

- 3画面を `<section class="screen" id="screen-home">` `id="screen-project"` `id="screen-modal"` として1ファイルに含める
- 各画面は **幅1600px × 高さ1000px の固定フレーム**としてデザインする(実アプリのビューポートを模す)。
  画面内のスクロールが必要な領域は overflow を隠してよい(見えている範囲がデザインの全て)
- ハッシュなしで開いた場合: 3画面を縦に並べ、各画面の上に小さなラベル(例「1. Home」)を表示
- `#screen-home` 等のハッシュ付きで開いた場合: **該当画面だけ**を表示し、ラベル・余白なしで
  ビューポート左上にぴったり配置する(ヘッドレス撮影用)。実装はインラインJSで
  `location.hash` を読んで body にクラスを付ける方式を推奨。`body { margin: 0 }` 必須

## 対象3画面と必須要素チェックリスト

実装の参照元(構造・文言の正): `src/client/views/homeView.ts`, `src/client/views/galleryView.ts`,
`src/client/views/generationPanel.ts`, `src/client/views/iterationTree.ts`, `src/client/views/assetModal.ts`,
`src/client/workflowUi.ts`, `src/client/main.ts`(renderHeader)。現行の見た目は `src/client/styles.css`。

### 共通: アプリヘッダー(画面1・2に表示)

- メニューアイコンボタン
- ブランド: ループアイコン + **GURUGURU** + サブテキスト「Iterative Generation Studio」
- 右側: 接続ステータス(緑ドット + 「ComfyUI 接続済み」)

※D案のみヘッダーを左アイコンレールに置換してよい(D案コンセプト参照)

### 画面1: Home(`#screen-home`)

左メイン + 右サイドの2カラム(D案はコンセプトに従い再構成可):

**メイン「Project一覧」パネル**
- キッカー「Projects」+ 見出し「Project一覧」
- 新規作成フォーム: 「Project名」input(placeholder: Daily Scene Character Exploration)、
  「説明」textarea、「デフォルトWorkflowTemplate」select、プライマリボタン「+ 新規Project作成」
- Projectカード×3(下記ダミーデータ)。各カード: サムネイル、名前、説明、
  メタ行「Rounds N / Assets N / Updated 日付」、ボタン「開く」「削除」(danger)

**サイド**
- 「Connection / ComfyUI接続」パネル: Base URL(`http://127.0.0.1:8188`)、WebSocket URL(`ws://127.0.0.1:8188/ws`)、
  Timeout秒(60)、保存先、WebSAM model base URL の各input + ボタン「保存」「接続テスト」
- 「テンプレート登録」プライマリボタンだけの小パネル
- 「Workflow / WorkflowTemplate」パネル: テンプレート行×3(名前 vN、type、
  アクション: diagram / export / 削除)

### 画面2: Project詳細(`#screen-project`)

左サイドバー(生成パネル、幅約320px)+ メイン(D案はレイアウト変更可、要素は同一):

**生成パネル(サイドバー)**
- キッカー「ワークフロー」: txt2img WorkflowTemplate select、img2img WorkflowTemplate select、
  折りたたみ「+ Workflow操作」
- キッカー「親画像」: ボタン「source asset をアップロード」
- キッカー「プロンプト」: textarea(下記プロンプト文)
- 折りたたみ「ネガティブプロンプト」: textarea(開いた状態)
- キッカー「生成パラメータ」+ ミニボタン「JSON初期値」:
  スライダー4本「バッチサイズ 16」「ステップ数 20」「CFGスケール 7」「デノイズ強度 0.55」
  (ラベル+現在値+min/max表示)、幅/高さ input(832 / 1216)+入替ボタン、縮小/拡大ボタン、
  「シード」input(-1)+シャッフルボタン、「seed mode」select(random)、
  「サンプラー」select(dpmpp_2m)、「scheduler」select(karras)、「mode」select(img2img)
- 折りたたみ「モデル」: モデル一覧(checkpoint: `sdxl_base_1.0.safetensors` / VAE: `sdxl_vae.safetensors` /
  LoRA 1: `detail-tweaker-xl v1.5`)

**メイン**
- ラウンドツールバー: 見出し「イテレーション #7」+ タグ「img2img」、
  サブ行「16枚生成・3枚選択中・completed」、
  右側: ボタン「全選択」「選択解除」「選択反転」、グリッド列数select「4x4」、ボタン「生成結果取得」
- 画像グリッド 4列×4行 = **16タイル**(下記タイル仕様)
- イテレーションツリー(横スクロール帯): 番号付きドット1〜12を接続線でツリー表示。
  構造: ルートA: 1→2→3、3から分岐(4)と(5)、5→6→7。ルートB: 8→9、9から分岐(10)と(11)、10→12。
  **#7がアクティブ**(強調)、#12は running(点滅/別色)、他は completed。
  ルート/ブランチごとに色相を変える(現行は `--branch-hue` によるHSL色分け)
- 下部アクションバー: 左に選択サムネ3枚 + 「3枚の画像を次のブランチングに使用」、
  右にボタン「リセット」(danger)「保存」「画像無しで生成」(primary)
  「選択画像でブランチング 3」(primary、カウントバッジ付き)

**画像タイル(16枚)仕様**
- タイルi(1〜16)のサムネは下記「サムネイルSVG共通レシピ」で生成
- 各タイル: 画像、左上チェックの選択バッジ、右上スター、右下ズームアイコン、左下「#N」番号、
  下端に seed チップ(`seed 373592855N` 形式)
- 状態: #2, #7, #11 = selected(枠強調+チェックON)、#7 = favorite(スターON)、
  #13 = rejected(減光)、#3, #9 = masked(「MASK」バッジ表示)

### 画面3: Assetモーダル・マスク編集モード(`#screen-modal`)

背景: 画面2を単純化した暗い背景(ぼかし/減光表現)。その上にほぼ全画面のモーダル:

- 左上: トグル「マスク編集 ON」(active状態)+ インジケータ「マスク編集モード / ブラシ / 48px」
- 右上: 閉じるボタン(×)
- **3カラム: 左パネル(約300px)+ 中央プレビュー + 右パネル(約300px)**

**左パネル「マスク・プロンプト」**
- ヘッダ: 見出し + ステータスバッジ「mask active」
- タブ3つ: 「手動編集」(active)「候補生成」「点クリア」
- ツールボタン行: ブラシ(active)/ 消しゴム / 反転 / クリア(アイコンボタン4つ)
- スライダー「ブラシサイズ 48px」(1〜256)
- 「Positive prompt」textarea(下記プロンプト文)
- スライダー「バッチサイズ 16」(1〜32、min/max表示)
- select「Masked content」(original)、select「Inpaint area」(Only masked)
- スライダー「Only masked padding 32px」(0〜512)、スライダー「Mask feather 8px」(0〜30)
- ボタン「✓ 適用」(primary)「手動修正クリア」

**中央プレビュー**
- 大きな画像(タイル#7と同じSVG絵柄を大きく表示)+ 半透明のマスク塗り領域(紫がかった塗り)を重ねる
- 前景プロンプト点(小さい円)を4つ、背景点を1つ画像上に表示
- 下部フッター: 「Seed: 3735928557 / Steps: 20 / CFG: 7 / Sampler: dpmpp_2m」+ プロンプト文(小さく)、
  ボタン「選択切替」「この画像からブランチング」(primary)

**右パネル「スマート選択」**
- select「Smart selection」= SlimSAM-77
- モデルカード: **SlimSAM-77**、説明「軽量SAM。Encoder 32MB / Decoder 5MB」、ステータスバッジ「Ready」(緑)
- プログレスバー(100%)
- ステータス行「Ready」+ ミニボタン「再試行」
- select「Prompt mode」(Point)
- スライダー「Threshold 0」(-10〜10)「Smoothing 2」(0〜4)「Mask opacity 0.6」(0〜1)
- ボタン行「候補生成」「点クリア」「SAM結果クリア」
- 候補ボタン3つ: 「Mask 1 92.4%」(active)「Mask 2 88.1%」「Mask 3 71.5%」
- カウント行「FG/BG 4/1」「Brush 0」「Zoom 100%」

## 共通ダミーデータ(全案で同一の文言を使うこと)

**Projects(3件)**
1. 「Daily Scene Character Exploration」/ 説明「毎日のキャラ探索。ポーズと衣装のバリエーション出し。」/
   Rounds 12 / Assets 214 / Updated 2026/07/01 / サムネ色相 270
2. 「Fantasy Landscape Series」/ 説明「背景素材のシリーズ生成。朝・夕・夜の光違い。」/
   Rounds 5 / Assets 96 / Updated 2026/06/28 / サムネ色相 140
3. 「Portrait Style Test」/ 説明「説明なし」/ Rounds 2 / Assets 31 / Updated 2026/06/15 / サムネ色相 20

**WorkflowTemplates(3件)**
- 「SDXL Basic」 v3 / txt2img
- 「SDXL Inpaint」 v2 / img2img
- 「Flux ControlNet」 v1 / controlnet

**プロンプト**: `masterpiece, best quality, 1girl, beautiful detailed eyes, flowing hair, fantasy landscape, dramatic lighting, ethereal atmosphere`
**ネガティブ**: `low quality, worst quality, blurry, deformed`

## サムネイルSVG共通レシピ(全案共通・全16タイル+Projectサムネ)

インラインSVG(またはdata: URI化したSVG)で「AI生成画像風」の抽象ポートレートを描く:

- タイルi(1〜16)の基準色相: `hue = (i * 23 + 200) % 360`
- 縦長構図: 上2/3にグラデ空(hueとhue+40の2色)、下1/3に暗い地面、
  中央にシルエット(頭=円 + 体=角丸長方形、暗色)、光源の円(hue+60、ぼかし風に透明度落とし)
- 見た目の統一のため、SVG絵柄の生成は1つのテンプレート関数/パターンから hue だけ変えて量産すること
- Projectサムネ・モーダル中央画像も同レシピ(モーダルは タイル#7 と同一色相=361%360)

## 評価の公平性に関する禁止事項

- 案ごとにデータ量・文言・要素数を変えない(「B案だけタイルが多い」等は禁止)
- プレースホルダの「Lorem ipsum」使用禁止(上記の実文言を使う)
- 特定の案だけ手を抜かない。全案とも本番品質の完成度で作ること
