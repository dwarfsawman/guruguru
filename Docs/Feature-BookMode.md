# Feature: Book モード（複数ページ）

## 概要

1プロジェクト = 1つの単一画像生成 UI だった構成に、漫画のような**複数ページ**をまとめる **Book モード**を追加した。
プロジェクト作成時に Single / Book を選択でき、Book を開くと**ページのグリッド**（漫画リーダー風）を表示、
各ページをクリックすると**既存の1枚生成 UI**にそのまま入る。グリッドは**ドラッグで並び替え**できる。
見た目は既存 UI の色・ボタン・トークン（`.panel` / `.image-grid` / `.segment-group` / `.tag` / `var(--...)`）に合わせている。

設計方針の要は「既存の1枚生成 UI を作り直さず、`generation_rounds.page_id` でラウンド/アセットをページに絞って再利用する」こと。
イテレーションツリー（`iterationTree.ts` の `buildRoundForest`）は渡された rounds 配列だけで森を再構築するため、
ページ絞り込みは安全（親不在ノードは root 扱い）。`round_index` / `branch_color_index` は project スコープのまま維持している
（ComfyUI 出力プレフィックスに使われるため）。ページ絞り込みでの番号/色の非連続は表示上のみで無害。

## データモデル（`src/server/db.ts`）

`ensureColumn`（既存の軽量マイグレーション）で追加:
- `projects.mode` TEXT NOT NULL DEFAULT 'single'（'single' | 'book'）
- `generation_rounds.page_id` TEXT（NULL 可。single は常に NULL）
- 新テーブル `pages(id, project_id, page_index, title, created_at, updated_at)` + index `idx_pages_project(project_id, page_index)`

`page_index` の昇順が読書順。ページは1プロジェクト内の「順序付きの独立した1枚生成コンテキスト」。

## サーバ

- **`projects.ts`**
  - `createProject`: `mode` を保存。book なら初期ページ（#01）を1枚作成。
  - `listProjects`: `mode` と `page_count` を返す。
  - `getProjectDetail(projectId, options, pageId?)`: `pageId` 有り=そのページ、無し=`page_id IS NULL`（single 相当）で
    rounds/assets/parents/pasteAttachments を絞る。SQL 値は全てパラメータ化（絞り込み句だけを条件分岐）。
- **`pages.ts`（新規）**: `listPagesWithProject`（代表サムネ+枚数付き）/ `createPage`（末尾追加）/ `updatePage`（タイトル）/
  `reorderPages`（`orderedIds` の順に page_index を 0..N-1 へ、BEGIN/COMMIT）/ `getPageDetail`（scoped detail + page メタ）/
  `deletePage`（ページの root ラウンドごとに `deleteRoundTree` → `discardRoundTrashSnapshot` でファイルも削除、残ラウンドも掃除）/
  `listRecentReferenceImages`（rounds の request_json から reference.imagePath を新しい順に収集）。
- **`rounds.ts` / `sourceAssets.ts`**: リクエスト body の `pageId` を受理・検証（当該 project のページであること）して `page_id` に保存。
- **`index.ts`**: `GET/POST /pages`、`POST /pages/reorder`（`/pages/:pageId` より前）、`GET/PATCH/DELETE /pages/:pageId`、
  `GET /reference-images` を追加。round POST に body.pageId を渡す。

## クライアント

- **ナビゲーション**: state 駆動。`render()` は `state.detail ? 1枚生成UI : state.book ? ページグリッド : Home`。book のページを開くと
  `state.detail` と `state.book` が両立し、詳細ビューに「← ページ一覧」パンくずを出す。
- **`bookController.ts`（新規）**: `openBook`（グリッド）/ `openPage`（ページの1枚生成UIへ）/ `backToPages` / `add/delete/rename/reorder`。
  ネイティブ HTML5 DnD で並び替え（専用 MIME `application/x-guruguru-page-id`、`data-key` で morph が既存 DOM を移動、
  ドラッグ中ハイライトは classList を直接操作し render を通さない、確定時のみ reorder API → 再描画）。
- **`bookView.ts`（新規）**: `.image-grid` にページタイル（サムネ/番号/タイトル、ホバーでリネーム・削除）。
- **`homeView.ts`**: `#project-form` に Single/Book の `.segment-group` トグル（アクティブ側 `button-primary`）。プロジェクトカードは
  book に `BOOK` タグ＋ページ数を表示。`open-project` は mode で分岐。
- **ページ別の参照/LoRA**: `state.referenceDraftsByPage` / `loraDraftsByPage`（page id キー）。`draftStore` の per-project blob に
  永続化し、永続化直前とページ切替直前に `commitActivePageDrafts()` で現ページへ書き戻す。`openPage` で復元。single は従来の
  フォームレベル1枚のまま。
- **最近使った参照画像ピッカー**: `generationPanel` の顔参照枠に横スクロール帯。`GET /reference-images` の候補を1クリックで再利用
  （fetch → dataURL 化して `referenceDraft` に設定）。Book のページ間で同じキャラ顔を使い回す用途。
- **ページ絞りの再取得**: `refreshProject` は `activePageId` があれば `/pages/:pageId` を叩く。round/asset id は全体一意なので
  keepRoundId/keepAssetId の reconciliation は無改修。バックグラウンドの `pollCollectRound` は開始時の `activePageId` を捕捉し、
  別ページへ移動したら return（別ページの detail で上書きするのを防ぐ必須ガード）。

## 検証

- `npm run typecheck` / `npm test`（381 tests）/ `npm run build` すべてグリーン。
- ヘッドレス API テスト（隔離データディレクトリ、ComfyUI 不要 — source asset はファイルコピーで生成可能）で 29 アサーション:
  マイグレーション、book 作成+初期ページ、ページ CRUD/reorder/rename/delete、**ページ絞り込みの隔離**（page A のラウンドが
  page B・generic detail に出ない）、代表サムネ+assetCount、削除でのラウンド/アセット purge、reference-images、single 回帰。
- ブラウザ検証（claude-in-chrome）: モードトグル、BOOK タグ+ページ数、book 作成→グリッド、ページ追加、ページを開く→1枚生成UI+
  「← ページ一覧」パンくず→戻る、**ドラッグ並び替え**（実 DragEvent で reorder API まで到達・永続化を確認）、コンソールエラー無し。
  ※ 実画像生成は ComfyUI 未起動のため未検証。リネーム/削除の UI はネイティブダイアログのため API 側で検証。

## 対象外（今回作らない）

ページ status/favorite、All/Draft/Done フィルタ、選択中ページの詳細サイドパネル、list/compact 表示切替、ページ複製、
mask/pose/reference 等の添付ファイルの削除掃除（既存の round 削除と同じ挙動を踏襲）。
