# Feature: 漫画レイアウトテンプレート（コマ割り）

## 概要

Book モードのページに**コマ割り（漫画パネルレイアウト）**の概念を追加した。ページ一覧から
**コマ割りテンプレートを選んでページ追加**でき、`.guruguru-layout.json5`（`dwarfsawman/guruguru-layout-template`,
SPEC v0.2）を**取り込んで登録**して再利用できる。別機能として、**画像を新規ページとして複数インポート**できる。
レイアウトを持つページは一覧に**コマ枠のスケルトンサムネ**を表示する。

将来の「コマ内を対象にした画像生成」「コマ形状の編集（構成を編集）」「吹き出し追加」に備え、データモデル
（`PageLayout`）は前方互換にしてある（今回は描画のみで、これらの編集/生成 UI は未実装）。

既存概念との命名衝突を避けるため、ComfyUI ワークフローの `workflow_templates` とは別に、本機能は
**レイアウトテンプレート / コマ割りテンプレート**（コード `layoutTemplate` / `PageLayout`）と呼ぶ。

## データモデル

### `PageLayout`（`src/shared/pageLayout.ts`・純ロジック / json5 非依存）

座標系は元フォーマットと同じ **width-relative-top-left**（origin=top-left, x∈[0,1], y∈[0,page.height],
長さの単位=page-width）。

- `page: { aspectRatio: [w,h]; height }`（width=1 正規化。height は pages[].height → aspectRatio → パネル y 最大 の順で解決）
- `readingDirection: "rtl" | "ltr"`、`panels: LayoutPanel[]`（`shape` は polygon/rect/ellipse/path、`frame` 省略時は描画既定）
- `balloons?` / `texts?` は**予約**（将来機能。取り込み時に保持のみ）、`source?` は取り込み元の素性
- `normalizeGuruguruLayout(parsed)`: `JSON5.parse` 済みオブジェクトを受け取り正規化。複数ページ（見開き）は
  先頭ページ + その pageId のパネルを採用。パネル 0 件は分かりやすい Error。

### DB（`src/server/db.ts`）

- `ensureColumn("pages","layout_json","TEXT")` — ページの `PageLayout`（JSON、通常ページは NULL）
- 新テーブル `layout_templates(id, name, source, layout_json, source_json5, created_at, updated_at, deleted_at)`（**グローバル**）
- `jsonColumnNames` に `layout_json → layout` を追加。`toApiRow()` が `pg.*` の `layout_json` を parse 済み `layout` に変換する
  （`listPagesWithProject` は SELECT 変更不要）。

内蔵プリセット（`src/shared/layoutPresets.ts` の `LAYOUT_PRESETS` 約8種：表紙/1コマ/2コマ上下・左右/3段/4コマ/6コマ/縦4段）は
**コード側**で持ち、DB には**取り込み分のみ**入れる（マイグレーション不要、プリセットはコードで自由に改善可能）。

## サーバ

- **`layoutTemplates.ts`（新規）**: `listLayoutTemplates`（内蔵+取り込みをマージ）/ `importLayoutTemplate`
  （`JSON5.parse`→`normalizeGuruguruLayout`→保存。失敗は 400）/ `deleteLayoutTemplate`（内蔵は不可・取り込みはソフト削除）/
  `resolveLayoutTemplate`（builtin/DB 両対応）。json5 依存はこのモジュール（サーバ）に閉じる。
- **`pages.ts`**: `createPage(projectId, body?)` が `body.layoutTemplateId` を解決して `layout_json` に保存。
  `importImageAsPage`（空ページ作成 → 既存 `createSourceAsset` でその画像を代表アセットに。ワークフローテンプレは project の
  default → 最初の非削除。失敗時は作った空ページを片付ける。**ファイルコピーなので ComfyUI 不要**）。
- **`index.ts`** ルート: `GET/POST /api/layout-templates`, `DELETE /api/layout-templates/:id`,
  `POST /api/projects/:id/pages/import-image`（`/pages/:pageId` より前）。既存 `POST /pages` は body を `createPage` へ渡す。

## クライアント

- **`views/pageLayoutSvg.ts`（新規）**: `renderPageLayoutSvg(layout, opts)` — 文字列 SVG。viewBox `0 0 1000 {1000*height}` +
  `scale(1000)` group 内に正規化座標で描画（path の `d` もスケール不要、線幅は frame.strokeWidth を比例スケール）。
  色は `var(--layout-paper/--layout-koma)`（機能固有の固定色 + hex フォールバックで単体描画も可）。
- **`views/layoutTemplateModal.ts`（新規）**: `.workflow-modal`/`.workflow-dialog` を踏襲したテンプレピッカー。
  各テンプレを SVG プレビュー付きカードで並べ、「このテンプレで追加」/ 取り込み分の削除 / `.json5` 読み込みを持つ。
- **`layoutTemplateController.ts`（新規）**: ピッカーの開閉・一覧取得・`.json5` 取り込み・テンプレ削除。
- **`bookController.ts`**: `addPage(layoutTemplateId?)` にテンプレ対応を追加（`add-page-from-template`）。
  `importImagesAsPages(input)`（複数画像を順に `/pages/import-image`、1枚失敗しても続行しトーストで要約）。
- **`views/bookView.ts`**: 見出しに「テンプレから追加」「画像をインポート(複数可)」を追加。ページカードのサムネは
  代表画像 → 無ければ `page.layout` のコマ枠スケルトン → 無ければ空。→ 一覧がコマ割り表示になる。
- **`main.ts`**: render の overlay region にピッカーを追加（`state.layoutPickerOpen && state.book && !state.detail`）。
  backdrop クリック解除は **`layout-template-modal` を `workflow-modal` より先に判定**（両クラスを持つため）。
  `change` 委譲に `data-layout-import`（.json5）と `data-image-import`（複数画像）を追加。
- **`appState.ts`**: `layoutPickerOpen: boolean`、`layoutTemplates: LayoutTemplateSummary[] | null`。
- **`styles/layout-templates.css`（新規）** + `styles/index.css` に import。`--layout-paper/--layout-koma` を root に定義。

## 検証

- `npm run typecheck` / `npm test`（410 tests。`pageLayout.test.ts` で添付6コマ json5 の正規化＝6コマ・aspectRatio[182,257]・
  polygon 点・frame 継承を pin）/ `npm run build` グリーン。
- ヘッドレス API（隔離データディレクトリ・test DB・非5177ポート、ComfyUI 不要、24 アサーション）: 内蔵8種、添付 json5 の
  取り込み＝6コマ、一覧マージ、`/pages {layoutTemplateId}` でページに layout 付与、GET pages の layout、`/pages/import-image` で
  ページ+アセット生成、テンプレ削除・内蔵は削除不可。
- ブラウザ（1680×920）: 一覧のコマ枠スケルトン、ピッカーのギャラリー（内蔵8+取り込み1）、**添付 json5 が2枚目画像どおりの
  傾きガター6コマで描画**、「このテンプレで追加」でページ追加（5→6・新カードが6コマ）、ファイル入力の属性（複数画像・.json5）、
  コンソールエラー無し。

## 対象外（今回作らない・データモデルのみ前方互換）

コマ形状の編集 UI（「構成を編集」）、吹き出し(balloon)の追加/配置 UI、path/ellipse コマの編集、
翻訳/テキスト効果。`PageLayout` に balloons/texts/各 shape 型を持たせ将来対応可能にしてある。

「コマ内を対象にした画像生成」は [`Docs/Feature-PanelGeneration.md`](Feature-PanelGeneration.md) で実装済み。
