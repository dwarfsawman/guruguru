# Feature: コマ内生成（パネルターゲット生成）

## 概要

漫画レイアウトテンプレートから作られたページ（`page.layout` を持つページ）で、個々のコマ（パネル）を選んでそのコマ向けに画像生成できる。ページカードをクリックすると専用の「コマ選択 lightbox」が開き、コマをシングルクリックで選択して「選択コマを生成」から生成画面へ遷移する。生成した画像をユーザーが「選択」すると、その生成が対象にしていたコマへ自動的に割り当てられる。割り当て済みコマは lightbox 上でクリップ表示され、ダブルクリックでクロップ編集モードに入り、ドラッグで表示位置（どの部分をコマとして切り取るか）を調整できる。

[`Docs/Feature-MangaTemplates.md`](Feature-MangaTemplates.md) の「対象外」に挙げていた「コマ内を対象にした画像生成」を実装したもの。

## データモデル

### `page_panel_assignments` テーブル（`src/server/db.ts`）

- `page_id, panel_id, asset_id, crop_json` の各列。`(page_id, panel_id)` ユニーク — 1コマにつき現在の割り当ては1件（差し替えは UPDATE）。
- `crop_json` は `jsonColumnNames` に登録し、`toApiRow()` が `crop`（parse 済み）へ自動変換する。

### `generation_rounds.target_panel_id`（新規列）

- そのラウンドがどのコマ向けの生成かを示す。対象外（通常生成/single モード）は null。
- `page_id` と同じ扱いの「サイドカー列」。`GenerationRequest`（ComfyUI 向けの JSON）には含めない。

### `PanelCrop`（`src/shared/pageLayout.ts`・純ロジック）

割り当て済み asset 画像のうちコマへ表示する範囲を、**asset 画像座標系で正規化**（`x, y, width, height` ∈ [0,1]）した「窓」＋ **`rotation`（ラジアン, 省略/0 で無回転）** として持つ。パン=`x`/`y`、拡大縮小（ズーム）=`width`/`height`（小さいほどズームイン）、回転=`rotation`（窓の中心まわりの画像回転）。`rotation` は後方互換のオプショナル追加で、無い/0 の既存レコードは従来と完全に同一の描画・エクスポートになる（DB マイグレーション不要）。

- `panelBounds(shape)` — パネルの外接矩形 `[minX, minY, maxX, maxY]`。`path` 形状は d 内の数値を (x,y) ペアとして拾うベストエフォート（内蔵プリセット/取り込み仕様は polygon/rect/ellipse のみを使うため実害なし）。
- `panelBoundsSize(bounds)` — 外接矩形の幅・高さ（0除算を避け最小値を敷く）。
- `defaultCoverCrop(assetW, assetH, boxW, boxH)` — asset をコマの外接矩形へ「cover」フィットさせた時の既定 crop（`rotation: 0`。アスペクト比が合わない方向を中央寄せでクロップ）。
- `clampPanelCrop` / `normalizePanelCrop` — 範囲・型の正規化（`rotation` は `(-π, π]` へ折り返す。サーバ側の入力検証にも使う）。
- `scaleCropAboutCenter(crop, factor)` — 窓を中心固定で `factor` 倍にズーム（`MIN_CROP_ZOOM_SIZE=0.05` で頭打ち）。コーナーハンドル/ホイールズームで使う。
- `normalizeRotation(value)` — 角度を `(-π, π]` へ折り返す（非数は 0）。

## サーバ

- **`panelAssignments.ts`（新規）**
  - `listPanelAssignments(pageId)` — そのページの全割り当て（`assets.width/height` を JOIN し `assetImageUrl` を付与）。
  - `upsertPanelAssignment(page, panelId, body)` — 割り当て更新。`body.assetId` が null なら解除（DELETE）。`body.crop` を省略した場合、**同一 asset への再割り当て（crop 更新）なら既存 crop を再利用**し、**新規割り当て/別 asset への差し替えなら cover フィット既定値を計算し直す**（別画像の座標系を誤って引き継がないため）。
  - `autoAssignPanelForSelectedAsset(assetId, roundId)` — asset が「選択」状態にされた時、そのラウンドに `target_panel_id` があれば自動でそのコマへ割り当てる。対象コマがレイアウト変更等で消えていても選択自体は失敗させず黙って諦める。
- **`rounds.ts`**: `createGenerationRound` に `targetPanelId` 引数を追加。指定時はそのページの `layout.panels` に実在する id か検証し、不正なら 400。コマ対象生成で親 asset が別コマ由来なら `parent_round_id` は引き継がず root 扱いにする（コマ間でイテレーションツリーを共有しないため）。
- **`assets.ts`**: `updateAssetStatus` で `status === "selected"` になった時に `autoAssignPanelForSelectedAsset` を呼ぶ。
- **`pages.ts`**: `getPageDetail` のレスポンスに `panelAssignments` を追加（`page.layout` が無ければ空配列）。`updatePagePanelAssignment` を新設。
- **`index.ts`** ルート: `PATCH /api/projects/:id/pages/:pageId/panels/:panelId/assignment`。既存 `POST /rounds` は body の `targetPanelId` を `createGenerationRound` へ引き回す。

## クライアント

- **`pagePanelLightboxController.ts` + `views/pagePanelLightboxView.ts`（新規）**: コマ選択/クロップ編集 lightbox。
  - シングルクリックはコマ選択のみ（`state.pagePanelLightbox.selectedPanelId` を更新）。asset カードの単/複クリック判定（`scheduleAssetCardSelect` 系）と同型に、click イベント側で遅延予約 + `dblclick` イベント側で実処理、という2イベント方式にしている（ブラウザ標準のダブルクリック判定に委ね、`event.detail` の連続性に頼らない）。
  - ダブルクリックは補助導線: 未生成コマなら生成 UI へ遷移、生成済みコマならクロップ編集モードへ。
  - 割り当て済みコマは `<clipPath>` + `<image>` でパネル形状にクリップ表示する。`pageLayoutSvg.ts` の形状ジオメトリ生成ロジックを `panelShapeElement`/`shapeCenter`/`num` として export し、clipPath の中身や枠線描画で再利用する。
  - クロップ編集は**参照画像貼り付け（Paste & Transform）と同型の UX**: パン（本体ドラッグ）/ 拡大縮小（コーナーハンドル + ホイール）/ 回転（上のハンドル、Shift で 15° スナップ、ダブルクリックで 0° リセット）。座標変換は `SVGGraphicsElement.getScreenCTM()` で「画面 px ↔ SVG 正規化座標 1 単位」の係数を得る（ダイアログの実表示サイズや `preserveAspectRatio="xMidYMid meet"` のレターボックスに関係なく正確。CSS の `aspect-ratio` 目算に頼らない）。パンは画像の `rotation` に合わせて画面デルタを image 軸へ回してから `x`/`y` に反映する。`pointerup`（ホイールは停止後 debounce）で1回だけ PATCH を送って確定する。
  - **拡大縮小は縦横比を必ず保つ**: `scaleCropAboutCenter` は width/height に同じ実効 factor をかけ、片辺だけ `[MIN_CROP_ZOOM_SIZE, 1]` 境界に当たって歪むことが無いよう factor を「両辺が範囲内」の区間へ丸める（cover 状態=片辺 1 の時はズームアウト不可）。
  - **枠外ダブルクリックで編集終了**: クロップ編集中、画像・ギズモハンドル以外（＝枠外）のダブルクリックは「選択に戻る」相当で `closeCropEditor()`（回転ハンドルのダブルクリック＝0°リセットとは `data-crop-handle` の有無で切り分ける）。
  - 編集中は**スポットライト表示**: 対象コマの画像はオーバーレイ（最前面）で描き、元画像全体を薄く出す `page-panel-image-ghost` の上に、コマ形状でクリップした明画像を重ねて「コマ領域だけ濃く」見せる。回転は clip を持つ外側 `<g>` と別の内側 `<image>` に付ける（同一要素だと clip も回るため）。その上に paste 風ギズモ（回転した外接矩形の枠 + コーナー=拡縮 / 上=回転 ハンドル）を描く。ハンドル半径・回転柄の長さは render ループ末尾の `syncPagePanelCropGizmo()` が `getScreenCTM()` で画面基準の一定サイズへ直す（`syncPasteGizmo` と同型）。**回転ハンドルはステージ外に切れて掴めなくなるのを防ぐため、外向き位置がページ範囲外になる場合は内向きへ反転する（`cropRotateHandlePoint`。最上段コマ対策。render と sync で同じロジック）。**
  - **編集後のページ一覧プレビュー更新**: ページ一覧のコマ割りプレビューは `/api/.../preview.png?v=<割り当ての最終更新時刻>`（コマ合成）。クロップを保存すると `panelPreviewDirty` を立て、lightbox を閉じる時に `bookController.reloadBookPages()` でページ一覧を再取得し、新しい `v=` で最新プレビューを表示する。
  - 「選択コマを生成」ボタン（選択コマが無い間は disabled）で `generateForPanel(pageId, panelId)` を呼ぶ。未生成コマのダブルクリックも同じ関数を使う。lightbox を閉じ、必要なら該当ページを開き（`bookController.openPage`）、`state.activePanelTarget` をセットし、既存の同コマ向けラウンドがあればそのラウンドを active にする。コマの外接矩形アスペクト比から生成フォームの width/height 初期値を計算する（目標面積 1024×1024・8 刻み丸め、`generationController.roundToStep` を再利用）。
- **状態（`appState.ts`）**
  - `pagePanelLightbox: PagePanelLightboxState | null` — lightbox の開閉・選択・クロップドラフト。
  - `pagePanelAssignments: PagePanelAssignment[]` — 開いているページの割り当て一覧。`PageDetail` を取得するたび（`openPage`/`refreshProject`/lightbox オープン時）更新する。
  - `activePanelTarget: { pageId, panelId } | null` — 生成フォームが対象にしているコマ。`openBook`/`openPage`/`backToPages`/`clearBookSession` でリセットされ、`generateForPanel` が明示的にセットし直す（ページを離れない限りラウンド切替をまたいで維持される）。
- **生成フォーム（`views/generationPanel.ts`）**: 対象コマがあればフォーム先頭に「ページN / コマM を生成中」バッジ + 「対象を解除」ボタンを表示する。
- **`generationController.ts`**: `generateRound()` の POST body に `targetPanelId: state.activePanelTarget?.panelId ?? null` を追加（`pageId` と同じサイドカー扱い）。`refreshProject()` はページを開いている時 `PageDetail` として型付きで取得し `state.pagePanelAssignments` も更新する。`activePanelTarget` がある間は active round の復元対象をそのコマのラウンドに限定する。
- **`main.ts` / `generationDraft.ts`**: `activePanelTarget` がある間はギャラリー・イテレーションツリー・per-round draft の参照を対象コマの `targetPanelId` に絞る。ページ内の他コマのラウンドは同じ `PageDetail` に含まれていても表示上は混ぜない。
- **`views/bookView.ts`**: `page.layout` を持つページカードは、代表画像の有無に関わらずクリックで `open-page-panels`（コマ選択 lightbox）を開く。持たないページは従来どおり汎用 zoom lightbox。

## OpenRaster エクスポート（`openRasterExport.ts`）

- `renderPanelImageLayer` は `crop.rotation` が 0/無しなら従来どおり `extract`（軸並行）→ `resize(fill)` → 形状マスク（回帰なし）。
- `rotation` ありは `renderRotatedPanelImageLayer` が**プレビューと同じ SVG transform**（clip を持つ外側 `<g>` + 回転する内側 `<image>`、auto-orient 済みソースを data URI で埋め込み）を canvas 解像度でラスタライズし、見た目を一致させる。

## 変更履歴

- 2026-07-09: クロップ編集フォローアップ — 拡大縮小の縦横比ロック（片辺だけ境界に当たる歪みを排除）、回転ハンドルがステージ外に切れて掴めない問題の反転対策（`cropRotateHandlePoint`）、枠外ダブルクリックで編集終了、編集後にページ一覧のコマ割りプレビュー（`preview.png?v=...`）を再取得して最新化。
- 2026-07-09: `PanelCrop` に `rotation` を追加し、クロップ編集を参照画像貼り付けと同型のパン/拡大縮小/回転 UX + スポットライト表示へ拡張。透明 outline がドラッグ pointer を奪っていた不具合も修正（画像をオーバーレイの最前面に出す）。OpenRaster エクスポートも回転対応。
- 2026-07-09: コマ対象中のギャラリー/イテレーションツリーを対象コマのラウンドに限定し、別コマ由来の親ラウンドを引き継がない方針を追記。

## 検証

- `bun run typecheck` 0 エラー、`bun test` 420/420（新規: `pageLayout.test.ts` に `panelBounds`/`panelBoundsSize`/`defaultCoverCrop`/`clampPanelCrop`/`normalizePanelCrop` の単体テスト11件）、`bun run build` グリーン。
- ヘッドレス API（隔離データディレクトリ・test DB・port 3000、ComfyUI 未接続でも検証できる範囲）: 割り当て作成時の cover フィット既定値自動計算、明示 crop での上書き、存在しない panelId の 400、`assetId: null` での解除、不正 `targetPanelId` を持つ round 作成の 400、有効な `targetPanelId` の round への永続化、asset 選択時の自動割り当て。24 アサーション全通過。
- ブラウザ（1680×920、実データ）: lightbox オープン → コマ選択 → 「選択コマを生成」有効化 → クリックで生成 UI 遷移（バッジ表示・width/height がコマのアスペクト比に追従することを確認）。「対象を解除」で解除。割り当て済みコマのダブルクリック → クロップ編集モード → ポインタドラッグ → pointerup で PATCH 自動保存 → lightbox 再オープンで位置が復元されることを確認。Escape でのクローズ、コンソールエラー無しを確認。

## 対象外（今回作らない）

- コマ形状そのものの編集（「構成を編集」、`Docs/Feature-MangaTemplates.md` から引き続き対象外）。
- 複数コマへの一括生成/バッチ操作。
- 回転ありコマで、窓がソース外へはみ出た領域（ズーム不足の隙間）を自動で塞ぐ処理。プレビューでは隙間が見える（＝ユーザーがズームで埋める前提）ままにしている。
