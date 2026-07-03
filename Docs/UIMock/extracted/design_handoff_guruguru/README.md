# Handoff: GURUGURU — Iterative Generation Studio

反復的な画像生成（ComfyUI 連携）のためのデスクトップ Web アプリ。プロンプト・パラメータを調整しながらバッチ生成し、良い画像を選んでブランチング（枝分かれ）していく「イテレーションツリー」型のワークフローを提供する。

---

## About the Design Files（設計ファイルについて）

このバンドルに含まれる `GURUGURU.dc.html` は **HTML で作られたデザインリファレンス**です。意図した見た目と挙動を示すプロトタイプであり、そのまま本番コードとしてコピーするものではありません。

タスクは、これらの HTML デザインを **ターゲットのコードベースの既存環境（React / Vue / Svelte など）で、その確立されたパターンとライブラリを用いて作り直す**ことです。まだ環境が無い場合は、このプロジェクトに最適なフレームワークを選定して実装してください（推奨は下記「Tech Notes」参照）。

> ⚠️ `GURUGURU.dc.html` は独自のストリーミング描画ランタイム（`support.js` / `<x-dc>` / `<sc-for>` / `renderVals()`）の上で動いています。これは **プレビュー専用の仕組み**であり、本番実装には移植しないでください。テンプレート構文ではなく「レンダリング結果の見た目・レイアウト・値」を参照してください。ブラウザで直接開けば完成形が確認できます。

---

## Fidelity

**High-fidelity (hifi)。** 最終的なカラー・タイポグラフィ・スペーシング・レイアウトが確定しています。既存コードベースのライブラリとパターンを使って、ピクセル単位で再現してください。値は下記「Design Tokens」に厳密に記載しています。

寸法について: モックは各画面を **1600 × 1000px** の固定フレームで描いています。これは「デスクトップアプリのウィンドウ1枚」を表す設計上のキャンバスであり、本番では通常のレスポンシブ／リサイズ可能なアプリウィンドウとして実装してください（3ペインは flex で伸縮、中央のグリッドが可変領域）。

---

## Screens / Views

### 01 — Home（プロジェクト一覧）
**Purpose:** プロジェクトの作成・一覧・管理、ComfyUI 接続設定、Workflow テンプレート管理。

**Layout:** 縦フレックス。上部に高さ 44px の固定ヘッダー、その下が横並び2カラム。
- **メインカラム（flex:1）:** パディング 16px。中に「Projects」カード。カード内は上部にタイトル行（`01 — Home` ではなく "Project一覧" ＋ 右に `3 projects · 341 assets`）、その下に新規作成フォーム、その下にプロジェクトカードのリスト。
- **サイドカラム（右, 幅 376px, `border-left`）:** パディング 16px、縦 gap 13px。「ComfyUI接続」カード → 「テンプレート登録」ボタン → 「WorkflowTemplate」カード。

**Components:**
- **Header**: 高さ44px、背景 `--panel`、下ボーダー `--line`。左からハンバーガーアイコンボタン（28×28）、ロゴ（24×24 角丸2px、`assets/spiral_faithful.svg` を `object-fit:cover; transform:scale(1.55)`）、`GURUGURU`（700 / 14px / letter-spacing .14em）、サブラベル `Iterative Generation Studio`（mono 10px uppercase, `--faint`）。右端に接続ステータスピル（`● ComfyUI 接続済み`、緑ドット `--good` 6px）。
- **新規プロジェクトフォーム**: 背景 `--panel2`、2カラムグリッド（gap 9px 12px）。フィールド = Project名（text input）、デフォルトWorkflowTemplate（select: `SDXL Basic v3` / `SDXL Inpaint v2` / `Flux ControlNet v1`）、説明（textarea 2行、全幅）、右寄せの `+ 新規Project作成`（accent ボタン）。
- **プロジェクトカード**（リスト, `projects` データ 3件）: 横並び。左にサムネイル 132×98（角丸2px, ボーダー `--line2`）、中央に名前（600/13px）・説明（`--muted`, 説明なしは `--faint` イタリック）・下部メタ行（mono 10.5px `--faint`: `Rounds N` / `Assets N` / `Updated YYYY/MM/DD`）、右に縦積みの `開く`ボタン（secondary）と`削除`ボタン（danger アウトライン, 高さ22px）。hover でボーダー `--line2` ＋ 背景 `--panel3`。
- **ComfyUI接続カード**: フィールド = Base URL(`http://127.0.0.1:8188`), WebSocket URL(`ws://127.0.0.1:8188/ws`), Timeout秒(`60`), 保存先(`./data/assets`), WebSAM model base URL(`/models/websam`)。全て mono フォントの input。下部に `接続`（accent, 全幅）ボタン。
- **WorkflowTemplate リスト**（`templates` 3件）: 各行に名前 ＋ バージョン（`--accent`, 例 `v3`）、右にタイプバッジ（`txt2img` / `img2img` / `controlnet`）、diagram / export / 削除 のアイコンボタン。

### 02 — Project（イテレーション生成画面）
**Purpose:** 1つのプロジェクト内で、左パネルのパラメータを設定 → バッチ生成 → 中央グリッドで結果を確認・選択 → 選択画像でブランチング。下部にイテレーションツリー。

**Layout:** ヘッダー（44px）＋横並び。
- **左ジェネレーションサイドバー（幅 324px, `border-right`）:** 縦にセクションが並ぶ（各セクション下ボーダー `--line`）:
  1. **ワークフロー**: txt2img / img2img の WorkflowTemplate セレクト、`+ Workflow操作`。
  2. **親画像**: `source asset をアップロード` ボタン（点線でなく通常の secondary、アップロードアイコン付き）。
  3. **プロンプト**: Positive textarea（mono, デフォルト値あり）＋ 折りたたみ「ネガティブプロンプト」textarea。
  4. **生成パラメータ**: JSON初期値ボタン、スライダー4本（`genSliders`: バッチサイズ16 / ステップ数20 / CFGスケール7 / デノイズ強度0.55）、幅832/高さ1216（入れ替え・リンク・追加アイコン付き）、シード(-1, 乱数アイコン, seed mode select)、サンプラー/scheduler/mode の select 群。
  5. **モデル**（`modelLines`）: checkpoint / VAE / LoRA の key–value 行。
- **中央メイン（flex:1）:** 縦積み。
  - **ツールバー（50px）:** 左に `イテレーション #7` ＋ `img2img` バッジ ＋ サブテキスト（`16枚生成 · 3枚選択中 · completed`）。右に 全選択/選択解除/選択反転 のセグメント、グリッドサイズ select（4x4/3x3/5x5）、`生成結果取得`ボタン。
  - **画像グリッド**: `repeat(4,1fr)` × `repeat(4,1fr)`、gap 8px、16タイル（`tiles`）。各タイル = 画像領域 ＋ 下部メタバー（20px: seed / dims）。オーバーレイ: 左上に選択チェックバッジ（選択時 accent 塗り）、右上にスター（お気に入り時 `--warn`）、`MASK` バッジ（マスク済み, `--warn`）、左下に `#index`、右下に虫眼鏡。選択タイルはボーダー `--accent`、却下タイル(#13)は `opacity:.28`。
  - **イテレーションツリー（110px, `border-top`）:** `Iteration Tree` ラベル ＋ `12 rounds · 2 roots`。SVG のノードグラフ（丸ノードにラウンド番号、枝でつながる。ROOT A 系は青系 `#3b6f80`、ROOT B 系は赤系 `#7a4a63`、現在アクティブ #7 は accent リング、実行中 #12 は `--warn` でパルスアニメ `ggpulse`）。
  - **アクションバー（58px, `border-top`）:** 選択画像サムネイル3枚（38×38, accent ボーダー）＋ `3枚の画像を次のブランチングに使用`、右に `リセット`(danger) / `保存` / `画像無しで生成` / `選択画像でブランチング`（accent, 末尾にカウントバッジ `3`）。

### 03 — Asset Modal（マスク編集モーダル）
**Purpose:** 単一アセットを開いて、マスク（inpaint 領域）を手動描画 or スマート選択（SAM）で作成し、その画像からブランチングする。

**Layout:** 画面02の上に暗転バックドロップ（`filter:brightness(.4)` ＋ `rgba(4,4,6,.5)` オーバーレイ）。中央に `inset:24px` のモーダル（角丸4px, 大きなドロップシャドウ）。モーダル内 = ヘッダー(44px) ＋ 3カラム。
- **左パネル（幅 302px）— マスク・プロンプト:** `mask active` バッジ。タブ（手動編集 / 候補生成 / 点クリア）。ブラシ/元に戻す/矩形/削除のツールボタン行。スライダー: ブラシサイズ48px、バッチサイズ16、Only masked padding 32px、Mask feather 8px。Positive prompt textarea。select: Masked content / Inpaint area。下部に `✓ 適用`(accent) / `手動修正クリア`。
- **中央プレビュー（flex:1, 背景 `#050506`）:** アスペクト比 832/1216 の画像。上に半透明の人型マスクシェイプ（accent 塗り, 点線ストローク）＋ 正クリック点（accent 丸）／負クリック点（赤 `#f87171`）。下部メタバー: `Seed / Steps / CFG / Sampler`（値は accent）＋ プロンプト全文。右に `選択切替` / `この画像からブランチング`(accent)。
- **右パネル（幅 302px）— スマート選択:** Smart selection select（`SlimSAM-77` / `MobileSAM` / なし）。モデルステータスカード（SlimSAM-77, `Ready` バッジ, プログレスバー 100%, 再試行）。Prompt mode select。スライダー（`smartSliders`: Threshold / Smoothing / Mask opacity）。候補生成/点クリア/SAM結果クリア。**Candidates** リスト（`Mask 1 92.4%` など、先頭は accent ハイライト）。下部に FG/BG・Brush・Zoom のカウントセル。

---

## Interactions & Behavior

- **画面遷移**: Home のプロジェクト「開く」→ Project(02)。Project のタイルをダブルクリック／虫眼鏡 → Asset Modal(03)。モーダルは ✕ かバックドロップクリックで閉じる。
- **タイル選択**: クリックでトグル。選択状態 = accent ボーダー ＋ 左上チェックバッジ。全選択／選択解除／選択反転で一括操作。スター＝お気に入りトグル（選択とは独立）。却下は淡色表示。
- **ブランチング**: 選択画像（複数可）を親として次のイテレーション（子ラウンド）を生成。ツリーに新ノードが追加される。
- **生成**: `生成結果取得`／`選択画像でブランチング`／`画像無しで生成` が ComfyUI にジョブを投げる。実行中ラウンドはツリー上でパルス（`ggpulse`: opacity 1↔.35, 1.1s ease-in-out infinite）。
- **マスク編集**: ブラシで塗る手動編集と、点クリック（FG/BG）で SAM が候補マスクを推論するスマート選択の2系統。候補は確信度%付きで複数提示、選択して適用。
- **接続ステータス**: ComfyUI 接続時ヘッダーに緑ドット ＋ `接続済み`。WebSocket で生成進捗を受信する想定。
- **hover 状態**: ボタンは `filter:brightness(1.08)`（accent 系）または背景を1段明るく（`--panel2`→`--panel3` 等）。input/textarea/select はフォーカスでボーダー `--accent`。
- **アニメーション**: 実行中ノードのパルスのみ。それ以外は原則モーション控えめ（プロフェッショナルツール）。

## State Management（想定される状態）

- `projects[]`（name, desc, rounds, assets, updated, thumbnail）、`activeProjectId`
- `connection`（baseUrl, wsUrl, timeout, saveDir, websamUrl, status: connected/offline）
- `workflowTemplates[]`（name, version, type）、選択中の txt2img / img2img テンプレート
- 生成パラメータ: prompt, negativePrompt, batchSize, steps, cfg, denoise, width, height, seed, seedMode, sampler, scheduler, mode, model 情報
- `iterations[]`（tree: id, parentId, root, status: active/running/completed）、`activeIterationId`
- 現イテレーションの `tiles[]`（index, seed, dims, selected, favorite, masked, rejected, imageUrl）
- モーダル: `openAssetId`, マスク編集状態（brushSize, maskData, points[], candidates[], selectedMask, SAM model status, スライダー各値）
- データ取得: ComfyUI REST（ジョブ投入・履歴）＋ WebSocket（進捗・完了）、生成画像は `保存先` に保存。SAM モデルは `WebSAM model base URL` からロード。

## Design Tokens

すべてルート要素の CSS 変数として定義済み（`GURUGURU.dc.html` 冒頭）。ダークテーマ、単一 accent。

**Colors**
- 背景/サーフェス: `--bg #000` / `--panel #0a0a0c` / `--panel2 #141417` / `--panel3 #1c1c20` / `--input #050506`
- ボーダー: `--line rgba(255,255,255,.09)` / `--line2 rgba(255,255,255,.17)`
- テキスト: `--ink #f4f4f5` / `--muted #8b8b93` / `--faint #57575e`
- Accent（既定・可変）: `--accent #E2AD81`、派生 `--accent-soft rgba(226,173,129,.16)` / `--accent-line …,.42` / `--accent-fill …,.34` / `--accent-strong #efceb5` / `--on-accent #08120f`（accent 上の文字色）
- ステータス: `--good #4ade80`（緑）/ `--warn #fbbf24`（黄）/ `--danger #f87171`（赤）
- ツリー枝色: ROOT A `#3b6f80`（青系）、ROOT B `#7a4a63`（赤系）、分岐 `#5a5570` / `#7a5a3a`

> **Accent はテーマ可変。** モックでは accent を差し替え可能なプロップにしている（候補: `#E2AD81 #14b8a6 #22d3ee #2f6bff #7c4dff #10b981 #f5a524 #fb7185`）。accent 変更時は soft/line/fill/strong と `--on-accent`（accent の輝度 >0.6 なら濃色文字、それ以外は淡色文字）を再計算する。ロジックは `GURUGURU.dc.html` の `applyAccent()` / `hexToRgb()` / `lighten()` を参照。

**Typography**
- 本文: `IBM Plex Sans`（400/500/600/700）。基準 12px / line-height 1.45。
- 等幅（数値・パラメータ・ラベル・コード的表示）: `IBM Plex Mono`（400/500/600）。
- セクションラベルは mono 10px / uppercase / letter-spacing .18em / `--faint`。見出しは Plex Sans 700。

**Spacing / Radius / その他**
- 角丸: 2px（コントロール類）／3px（カード）／4px（モーダル）。細身で角ばった精密ツール感。
- コントロール高さ: input/select/button = 28px、小ボタン 22px、ヘッダー 44px、ツールバー 50px。
- スライダー: トラック高さ 3px、`--input` 背景 ＋ accent フィル、つまみ 9×11px の `--ink` 角丸。
- シャドウ: モーダルのみ `0 24px 70px rgba(0,0,0,.72)`。それ以外はフラット（ボーダーで階層表現）。
- アイコン: 11–14px の細線（stroke-width 1.1–1.4）インライン SVG。currentColor 追従。

## Assets

- `assets/spiral_faithful.svg` — GURUGURU のロゴマーク（渦巻き）。ヘッダーで 24×24 の accent 背景の上に `object-fit:cover; transform:scale(1.55)` で表示。
- グリッド/サムネイルの画像はプレースホルダー（`plate(i)` が生成する人型シルエットの SVG data-URL）。本番では ComfyUI が生成した実画像 URL に差し替える。
- 「ChatGPT Image …png」「mock.html」はプロジェクト内の初期スケッチ／参考であり、本番デザインの正は `GURUGURU.dc.html`。

## Tech Notes（実装の指針）

- **推奨スタック**: ローカル ComfyUI（`127.0.0.1:8188`）と WebSocket でつなぐデスクトップ志向アプリのため、React + Vite（あるいは Electron / Tauri でのデスクトップ化）が素直。状態は Zustand / Redux 等。
- 3ペインは CSS Grid/Flex で。中央グリッドのみ可変、左右サイドバーは固定幅。
- スライダー・セレクト・トグルは既存 UI ライブラリのコンポーネントに置き換え、上記トークンでスタイリング。モックの手描きスライダー DOM はそのまま移植しない。
- 数値・シード・パラメータ表示は等幅フォントを維持すると、モックの精密ツール感が出る。
- ツリーは SVG／Canvas またはグラフ描画ライブラリ（例: elkjs でレイアウト）で。ノード色分けとアクティブ／実行中の状態表現を保持。

## Files

- `GURUGURU.dc.html` — 3画面すべてのハイファイデザイン（正）。ブラウザで直接開いて確認可。冒頭ルート要素に全デザイントークン、末尾 `<script>` に画面データ（`projects` / `templates` / `genSliders` / `tiles` など）と accent 計算ロジック。
- `assets/spiral_faithful.svg` — ロゴ。
- `support.js` — プレビュー用ランタイム（**参照不要・移植しない**。`.dc.html` をブラウザで開くためだけに同梱）。
