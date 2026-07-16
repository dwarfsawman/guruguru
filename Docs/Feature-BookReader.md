# Feature: Book Reader（漫画ビューア）

## 概要

Book モードのページ一覧グリッドに、Mihon / Komikku 系の**閲覧モード（Book Reader）**を追加した。
ページ一覧の「読む」ボタンで全画面ビューアを開き、**右→左（日本漫画）/ 左→右（コミック）**のページ送り、
**1ページ / 見開き**表示、**表紙・扉絵のズレ補正（見開き開始ページ）**に対応する。既存の1枚生成 UI /
ページ追加 / 並び替え / Book共通設定には手を加えていない（Reader は表示専用で、生成・削除・リネームは行わない）。

設計方針の要は「**ページのペアリングとページ送りを DOM から分離した純関数（`bookReader.ts`）にし、
ユニットテストで pin する**」こと。Reader は既存の1枚生成 UI 遷移（`state.detail`）とは独立した状態
（`state.bookReaderOpen` ほか）で、ページ一覧の別状態として全画面オーバーレイ表示する。

## 状態遷移

`Home → Book page grid → (Book reader | Page detail/生成UI | Book common settings)`

Reader は `state.detail` を使わず、専用フラグで制御する（両者は排他）。render 分岐（`main.ts`）:
`detail ? 生成UI : bookReaderOpen ? Reader : bookSettingsOpen ? 共通設定 : book ? グリッド : Home`。

## 状態（`appState.ts`）

- `bookReaderOpen: boolean` — Reader 表示中か。
- `bookReaderPageIndex: number` — 現在表示中の論理ページ index（0-based。見開き時は表示の先頭ページ）。
- `bookReaderSettings: BookReaderSettings` — 表示設定（下記）。プロジェクト別に localStorage 永続化。
- `bookReaderSettingsOpen: boolean` — Reader 内の設定ドロワーの開閉。

Book セッションを離れる/開き直す時（`bookController` の `openBook` / `clearBookSession`）に Reader フラグを
リセットする（reader controller への依存を避け、state フラグのみ操作）。

## 純ロジック（`bookReader.ts` / `bookReader.test.ts`）

「論理ページ順」= `pages.page_index` 昇順（= 配列順、0-based）。`spreadStartIndex` は UI 上 1-based、
内部で 0-based の `spreadStart` に変換。

```ts
interface BookReaderSettings {
  direction: "rtl" | "ltr";
  layout: "single" | "spread";
  spreadStartIndex: number;               // 1-based。これより前は単ページ
  showPageNumber: boolean;
  fitMode: "fit-screen" | "fit-width" | "fit-height";
  background: "black" | "gray" | "white";
}
// 既定: { direction:"rtl", layout:"single", spreadStartIndex:1, showPageNumber:true, fitMode:"fit-screen", background:"black" }
```

- `normalizeBookReaderSettings(input)` — 任意入力（localStorage の JSON 等）を有効値へ矯正。`spreadStartIndex`
  は 1 以上の整数へクランプ。
- `canonicalReaderIndex(index, len, settings)` — index を「表示の先頭ページ index」に正規化。single は
  クランプのみ、spread は見開き領域内をペア先頭（`spreadStart` から 2 つ刻み）へ丸める。設定変更・ページ送りは
  すべてこの正規化を通す（見開き境界に必ず揃う）。
- `getReaderStep` / `goNextReaderIndex` / `goPrevReaderIndex` — 移動単位（単ページ領域=1、見開き領域=2）と
  次/前の先頭 index。末尾/先頭でクランプ。
- `firstReaderIndex` / `lastReaderIndex` — Home / End用。見開きでは末尾ページを含むペア先頭へ正規化する。
- `getVisibleReaderPages(pages, index, settings)` — 表示ページを **DISPLAY 順（画面の左→右）** で返す。
  spread かつ **`direction==="rtl"` は左右を反転**（先の論理ページを右に置く＝漫画本として自然）。最終ページが
  片側だけになる場合は 1 ページ。画像の有無は問わない。
- `readerPageLabel(visible, total)` — 単ページ `3 / 12`、見開きは論理番号昇順で `2-3 / 12`。

### 見開きペアリング仕様

`spreadStart = spreadStartIndex - 1`（0-based）。index `< spreadStart` は単ページ、以降を `(spreadStart, +1)`,
`(spreadStart+2, +3)`, … の2枚ずつペア。例（`spreadStartIndex=2`）: 1p 単 → 2-3 見開き → 4-5 見開き …。
RTL 見開き `2-3` は画面で **右に 2 / 左に 3**。

### ナビゲーション方向

**「画面の右＝次へ / 左＝前へ」で固定**（キーボードの ArrowRight・Space・右クリックゾーン＝次、ArrowLeft・
左クリックゾーン＝前）。`direction` は**見開き時の左右の並びだけ**を切り替える（ナビのキー割当は変えない）。
これはタスク指定のクリック/キー割当（RTL/LTR いずれも右＝次・左＝前）に厳密準拠したもの。将来 Mihon 流に
「RTL は左＝次」へ寄せたい場合は `bookReaderController` の `handleBookReaderKeydown` とクリックゾーンの
data-action の対応を差し替えるだけでよい。

## 操作

- **ボタン**: 閉じる / 前へ / 次へ / 設定表示切替（topbar）。
- **キーボード**: `ArrowRight`・`Space`＝次、`ArrowLeft`＝前、`Home`＝先頭、`End`＝末尾、`Escape`＝設定ドロワーを
  閉じる→無ければ Reader を閉じる。数値入力等 text-entry にフォーカス中はページ送りキーを奪わない。
- **クリックゾーン**: stage 全面を左右2分割（左＝前 / 右＝次）。topbar・設定ドロワーのボタンはゾーンより上の
  レイヤなのでページ送りは発火しない。
- **設定ドロワー**: 方向 / 表示（単・見開き）/ 見開き開始（ステッパー）/ フィット / 背景 / ページ番号。

## 画像 URL（`pages.ts` / `apiTypes.ts`）

`PageSummary` に `representativeImageUrl`（`/api/assets/<id>/image` = フル画像）と `representativeAssetId` を
追加。グリッドは従来どおりサムネ（`representativeThumbnailUrl`）、Reader は高解像度のフル画像を使う。代表アセットの
選び方は既存のまま（selected/favorite 優先 → 無ければ最新 generated）。画像のないページは Reader 上で
プレースホルダ（`Page 04` ＋「このページにはまだ代表画像がありません」）表示。

## 永続化

`loadBookReaderSettings(projectId)` / `saveBookReaderSettings(projectId, settings)`（`bookReaderController`）で
`guruguru:bookReaderSettings:<projectId>` に保存。プロジェクトを跨いで混ざらない。将来 DB 化に備え read/write を
分離してある。

## UI（`views/bookReaderView.ts` / `styles/book-reader.css`）

全画面オーバーレイ（`position:fixed; inset:0; z-index:60`。トースト=70 より下なのでエラー通知は前面に残る）。
topbar・設定ドロワー・ページ番号ピルは常に暗い solid/半透明の面を持たせ、背景色（黒/グレー/白）に依らず可読。
画像は `object-fit:contain`、フィット3種はいずれも画面内に収める（パンなし）。見開きは中央に細い gutter。
既存トークン（`.panel` / `.button-primary` / `.segment-group` / `var(--...)`）を流用し、色は原則 `var()`。
背景の black/gray/white は「ページのレターボックス色」という機能固有の選択肢として、root スコープの名前付き
ローカル変数に集約している。

## 付随修正: ページ並び替えドラッグの不具合 + 挿入位置プレビュー

ページカードの並び替えドラッグが**実マウスで開始できない**不具合を修正し、あわせて**どこへ挿入されるかの
プレビュー**を追加した。

- **原因**: 並び替えは native HTML5 DnD で実装されていたが、カード全面を覆う `.page-card-open`（`<button>`）の
  上では Chromium が draggable な祖先のドラッグを開始しない（form control はドラッグ元にならず、掴める非フォーム
  領域も無い）。synthetic DragEvent は初期化フェーズを経ないため従来のブラウザ検証（DragEvent 直接 dispatch）では
  露見していなかった。
- **修正**: native DnD を撤去し、**Pointer Events で自前実装**（`bookController.ts` の `bindPageDragEvents`）。
  `pointerdown` → 6px 閾値超えで drag 開始（`page-dragging` で減光 + `setPointerCapture`）→ カーソル近傍のカード
  から挿入位置（前/後ろ/末尾）を算出 → **挿入インジケータ（accent 色の縦バー `.page-drop-indicator`）**を
  カード間ギャップに表示 → `pointerup` で確定（変化があれば reorder API）。マウス/タッチ/ペンを pointer で一括で
  扱える（`.page-card { touch-action: none }`）。
  - ペアリング/確定順は純粋な配列操作（`slotToOrderedIds`）に切り出し。挿入バーは `.page-grid` を
    `position: relative` にした上での絶対配置で、毎 `pointermove` に getBoundingClientRect で再計算。
  - ドラッグが成立した直後の `click`（=ページを開く）は capture phase で1回だけ握り潰す（`suppressPageCardClick`）。
    移動が閾値未満なら通常クリック＝ページを開く挙動は不変。並び替え確定（reorder API）・キー付き morph も不変。

## 検証

- `npm run typecheck` / `npm test`（`bookReader.test.ts` 15 件: normalize / single rtl・ltr /
  spread rtl start=1・2・3 / spread ltr start=2 / 最終ページ片側 / 画像なし混在 / 0ページ / 範囲外クランプ /
  canonical / Home・End境界）/ `npm run build` すべてグリーン。
- ブラウザ検証（隔離データディレクトリ + 6ページの Book。1/2/3/5 に画像、4/6 は画像なし。viewport 1680x920）:
  「読む」表示・開閉・Escape カスケード、キーボード＆クリックゾーンのページ送り、RTL/LTR 切替で左右反転、
  単/見開き切替、`spreadStartIndex=2` で 1p 単→2-3 見開き、フィット3種・背景3色・ページ番号トグル、
  代表画像がフル画像 URL、画像なしページのプレースホルダ、既定が RTL（localStorage クリア後）。
  並び替えは Pointer Events を dispatch して検証: 閾値超えで drag 開始、挿入インジケータがカード間ギャップの
  正しい位置に出る、`pointerup` で意図どおりの順序（page1 を page3 の後ろ→`[2,3,1,4,5,6]`）を reorder API へ送出・
  DOM も追従、閾値未満は通常クリックでページを開く、ドラッグ後の click は抑止される、を確認。コンソールエラー無し。

## 対象外 / 既知の制限

- フィットは「画面内に必ず収める」設計でパン/スクロールは無し（`ビューア全体は画面内に収まる`要件優先）。
- ページのブックマーク/しおり、連続スクロール（webtoon）表示、タッチ端末のスワイプは対象外（デスクトップ前提）。
- Reader からの生成・削除・リネームは行わない（既存のページ一覧/1枚生成 UI の責務）。

## 変更履歴

- 2026-07-16: `Home` / `End`による先頭・末尾ジャンプを追加。見開き時もペア先頭へ正規化する。
