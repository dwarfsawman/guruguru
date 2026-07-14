# ページ編集サイドバー UX 改善バッチ(2026-07-14)

ユーザーフィードバック(スクリーンショット3枚)に基づく、Book ページ編集 lightbox のレイヤサイドバー
(2026-07-14 の「feat: unify page editing into layer sidebar」= `8094aec` で統合されたもの)への改善。
本書が仕様の正。トーン追加機能は別紙 `Docs/Feature-ScreenTones.md`。

対象コード(現状):

- `src/client/views/pagePanelLightboxView.ts` — サイドバー全体(`renderObjectsToolbar` / `renderContentSection` / `renderBoxPropertyPanel` / `renderBalloonPropertyPanel` / `renderTextObjectPanel` / `renderPageLayerList`)
- `src/client/pageObjectsController.ts` — フィールド更新(`updateBox/Balloon/Text/ImageOwnField`)・テキスト入力(`updatePageObjectTextFromInput`)・選択/削除/ドラッグ
- `src/client/views/chronicleBarView.ts` — Chronicle バー(Beat チップ+Beat プレビュー)
- `src/client/styles/page-panel-lightbox.css`・`src/client/styles/chronicle-bar.css`
- `src/client/pagePanelLightboxController.ts` — lightbox 状態(`dialogueDrawer` 開閉ほか)

---

## 課題A: 選択レイヤ設定パネルのテキスト編集 UX(項目1・2・3・4・6)

### A-1. SETTINGS 見出しをテキスト編集フィールドにする(項目1)

**現状**: `.page-layer-settings-header` の `<h3>` にオブジェクト名(= content.text の先頭)を静的表示。
本文編集はパネル最下部の「テキストを載せる」チェック+textarea まで辿らないとできず、見出しが
編集できそうに見えるのに編集できない。

**仕様**:

- balloon / box / text オブジェクト選択時、`<h3>` の位置を**編集可能な textarea**(見出し風スタイル)に
  置き換える。これが本文テキストの唯一の編集欄(下部 textarea は撤去 → A-2)。
- 既存の input 委譲(`data-page-object-text="1"` → `updatePageObjectTextFromInput`)をそのまま使う。
  domMorph がフォーカス中要素の value を保護するので再描画で編集は壊れない(実証済みパターン)。
- 複数行対応: `field-sizing: content` + `max-height`(約6行)+ overflow-y auto。Chrome 150 前提なので
  `field-sizing` は使用可(tokens-base.css 冒頭の規約参照)。placeholder は kind 別
  (「セリフを入力」「テキストを入力」等)。
- content が null/未定義の box / balloon に入力された場合、`updatePageObjectTextFromInput` 側で
  content を新規作成する: box は `{ text, style: { ...DEFAULT_TEXT_STYLE, direction: "horizontal" } }`、
  balloon は `{ text, style: { ...DEFAULT_TEXT_STYLE } }`(既存 hasContent=ON 時の初期値と同じ)。
- image オブジェクト・コマ選択・未選択時は従来どおり静的見出し(「画像」「コマ N」「レイヤを選択」)。
- レイヤ一覧の行名(`pageObjectLayerName`)は content.text 由来なので、入力に応じてライブ更新される
  (既存挙動のまま。空文字なら「吹き出し」等のフォールバック名)。

### A-2. 「テキストを載せる」チェックボックスの撤去とテキスト消失バグの解消(項目4・6)

**現状バグ**: チェック OFF → `content = null` で本文ごと破棄・保存。再 ON で box は「テキスト」、
balloon は空文字から作り直し = **入力済みセリフが戻らない**(報告どおり)。また box は「テキストを
載せる」チェックの奥にテキスト機能が隠れており、ユーザーは「ボックスにテキスト機能がない」と
認識していた(項目6の正体)。

**仕様**:

- `renderContentSection` のチェックボックス(`hasContent`)を**撤去**。本文編集は A-1 の見出し
  フィールドに一本化し、下部の textarea も撤去する。
- テキストを消す手段は「全選択して削除」= 空文字。**空文字になっても content オブジェクトは保持**
  (style 設定が残る)。`normalizeTextContent` は `text: ""` を許容済みで、描画も空グリフで無害
  (createBalloonObject の既定 content が既に `text: ""`)。
- controller の `updateBoxOwnField` / `updateBalloonOwnField` から `hasContent` 分岐を削除。
- スタイル欄(`renderTextStyleFields`)の表示条件は「content がある時」のまま(balloon は生成時から
  content があり、box も1文字入力すれば現れる)。
- text オブジェクトのパネル(`renderTextObjectPanel`)も先頭 textarea を A-1 の見出しフィールドへ
  一本化(折り返し幅などの残りはそのまま)。

### A-3. フォームコントロールのダークテーマ化+ドロップダウン明示(項目2・3)

**現状**: `.page-object-property-field select` と `.page-object-textarea` が
`background: var(--surface, #fff)` — **`--surface` は未定義でフォールバックの白が発動**、ダーク UI の中で
眩しい。さらに select(形状・揃え・フォント・向き・レイヤー帯・クリップ先)が白い箱に見え、
テキスト入力欄と誤認される。

**仕様**:

- サイドバー内のフォームコントロールを既存トークンでダーク化する:
  - select: `background: var(--panel-strong)`(または `--panel-soft`)、`color: var(--ink)`、
    `border: 1px solid var(--line-strong)`。`appearance: none` + data-URI のシェブロン(▾)を
    `background-image` で右端に描き、`padding-right` を確保 — 「選択式」であることを見た目で示す。
    hover で border/背景を一段明るく(ボタンに寄せる)。
  - textarea(A-1 の見出しフィールド含む): `background: var(--input)`、`color: var(--ink)`、
    focus 時 border 強調。
  - `input[type="number"]`: 同トークンで明示的にダーク化(現状 UA 任せ)。
  - checkbox: `accent-color`(残存チェックボックス: しっぽ・フチ・折り返し幅・粒度指定)。
- `rg 'var\(--surface'` で src/client/styles/ 内の同種フォールバック白を洗い出し、ページ編集
  サイドバー系は全て修正。サイドバー外の該当箇所は変更せず報告のみ(スコープ管理)。

### A-4. 受け入れ条件(課題A)

- 吹き出し選択 → SETTINGS 見出しでそのまま本文を編集でき、紙面とレイヤ一覧名が追従する。
- content 無し box に見出しフィールドから入力するとテキストが載る(スタイル欄も出現)。
- テキストが利用者の操作なしに消える経路がない(チェックボックス自体が存在しない)。
- select が全てダーク+シェブロン付き。textarea/number もダーク。
- `bun test` 全体緑・`bun run typecheck` 緑。

---

## 課題B: セリフタブの整理(項目5・8)

### B-1. Chronicle バーをセリフタブへ移す(項目8)

**現状**: サイドバーは「レイヤ」「セリフ」タブ(`dialogueDrawer.open` トグル)を持つが、
`renderChronicleBar` は `renderPagePanelLightbox` がタブと無関係にサイドバー末尾へ常時描画しており、
**レイヤタブにもセリフ(Chronicle チップ列)が出る=役割重複**。

**仕様**:

- レイヤタブ = オブジェクト(手動吹き出しのテキスト編集含む)。セリフタブ = 脚本由来セリフの管理。
- `renderChronicleBar(chronicleBar)` の描画をセリフタブ(`dialogueDrawer.open === true`)配下へ移動する
  (セリフドロワー内の先頭または末尾、視覚的に一体化させる)。レイヤタブでは描画しない。
- Chronicle の状態管理・API 呼び出し(`chronicleController.ts`)はそのまま。表示場所の移動が主眼。
- 「手動吹き出し(sourceDialogueLineId 無し)は自動割り付けの対象外」が現状仕様として保たれていることを
  コードで確認する(reflow / 一括配置 / 配置案 preview が placement 紐付きオブジェクトのみを対象と
  していること)。破れがあれば最小修正+回帰テスト、無ければ確認結果をレポートに記す(コード変更不要)。

### B-2. Beat チップのアコーディオン展開(項目5)

**現状**: Beat チップ(代表セリフ+「Nセリフ」)クリックで `previewBeatId` が立ち、チップ列の**下**に
「セリフ一覧/タグは先頭セリフを代表表示」見出し付きのプレビューパネルが別枠で出る。どのチップの
内容なのか視覚的につながらない。

**仕様**:

- クリックした Beat チップの**直下に**、その Beat 内の各セリフ行をドロップダウン(アコーディオン)
  展開する。開いたチップは `is-expanded` 等で強調し、シェブロン回転などで開閉が分かるようにする。
- `renderBeatPreview` の中身(行ごとの 話者/本文/配置状態、「対応吹き出しへジャンプ」、ロック解除 🔓)は
  機能維持のまま展開部へ移植する。**「セリフ一覧」「タグは先頭セリフを代表表示」の見出し行は削除**
  (ユーザー明示要望)。行数・文字数サマリはチップ側に既にあるので重複表示しない。
- Shift+クリックの範囲選択(`selectedBeatIds`)・選択サマリパネル・一括割り当て/解除・配置案/確定は
  現行機能のまま(通常クリック=開閉トグル、Shift+クリック=選択、の役割分担を維持)。
- `chronicleBarView.test.ts` を新構造に追従させる(見出し削除・展開の DOM 構造)。

### B-3. 受け入れ条件(課題B)

- レイヤタブに Chronicle チップ列が出ない。セリフタブで従来の全機能(チップ・割り当て・再配置・
  ロック解除・配置案)が使える。
- Beat チップクリックでチップ直下に行一覧が展開され、再クリックで閉じる。「セリフ一覧/タグは
  先頭セリフを代表表示」の文言が UI から消えている。
- 手動吹き出しが自動割り付け・再配置で書き換えられないことの確認結果(または修正+回帰テスト)。
- `bun test` 全体緑・`bun run typecheck` 緑。

---

## 課題C: 複数選択とグループ(項目7)

### C-1. データモデル

- `PageObjectBase` に `groupId?: string` を追加(`src/shared/pageObjects.ts`)。
  - `normalizeBase` で**必ず保持**する(sourceDialogueLineId と同じ「正規化往復で消えると壊れる」罠)。
  - 空文字/非文字列は捨てる。後方互換: 旧データに無くても良い(optional)。
  - `.gguru` エクスポート/インポートは objects_json を丸ごと運ぶので追加対応不要。

### C-2. 選択モデル(Shift+クリック複数選択)

- `state.selectedPageObjectId: string | null` を `state.selectedPageObjectIds: string[]` へ拡張
  (先頭を primary とする。既存の単一選択 API/描画に合わせるヘルパを用意)。
  undo 履歴スナップショット(`pageObjectHistory.ts` の `selectedId`)も配列へ追従、テスト更新。
- ステージ(紙面)のオブジェクトクリック / レイヤ一覧行クリックの両方で:
  - 通常クリック: 単独選択(グループに属していれば**グループ全員**を選択)。
  - Shift+クリック: 対象(グループ所属ならそのグループ全員)を選択集合へトグル追加/除去。
  - Alt+クリック: グループを無視してその1個だけを選択(グループ内個別編集の逃げ道)。
  - 空白クリック: 全解除(現行踏襲)。
- Shift 修飾の取得は `registerActions` では拾えないため、`chronicleController.ts` の Beat チップ
  (bindChronicleEvents)と同じ `registerEventBinder` パターンで実装する。
- コマ(panel)行の選択は従来どおり単一(複数選択の対象はページオブジェクトのみ)。

### C-3. 複数選択時の挙動

- **移動**: 選択中オブジェクトのどれかをドラッグ → 全員に同じ delta を適用。ドラッグ確定時の
  undo は1エントリ、Chronicle 手動編集通知(`notifyChroniclePageObjectManualEdit`)は動いた各
  オブジェクトに対して呼ぶ。
- **削除**: Delete キー / 削除ボタンで選択全員を削除(undo 1エントリ)。
- **拡縮・回転**: v1 では単一選択時のみ(複数選択時はギズモのハンドルを出さず、外接枠のみ表示)。
- **z順(↑↓)**: 複数選択時は無効(disabled)で可。
- SETTINGS パネル: 複数選択時は「N個選択中」+「グループ化」「グループ解除」「削除」ボタンを表示
  (個別プロパティ欄は出さない)。

### C-4. グループ

- 「グループ化」: 選択中(2個以上)の全オブジェクトへ新規 `groupId`(createId 相当のユニーク文字列)を付与。
  既にグループ所属のものが混ざっていれば新グループへ付け替え(= グループ結合)。
- 「グループ解除」: 選択中オブジェクトの `groupId` を削除。
- レイヤ一覧: グループ所属行に控えめなバッジ(例: 🔗 or "G")を表示。同一 groupId のバッジは
  ツールチップで識別できれば良い(専用のグループ行 UI・入れ子表示は v1 スコープ外)。
- 保存: 既存の debounce PATCH(objects_json 全量)に乗るだけ。サーバ変更は normalize の保持のみ。

### C-5. 受け入れ条件(課題C)

- Shift+クリックで紙面・レイヤ一覧の両方から複数選択でき、まとめて移動・削除できる。
- グループ化後は通常クリックで全員選択になり、Alt+クリックで個別選択できる。グループは
  保存・再読込(lightbox 開き直し)後も維持される。
- `normalizePageObjects` 往復で groupId が消えない単体テスト、グループ選択/移動の純ロジック部の
  テストを追加。`bun test` 全体緑・`bun run typecheck` 緑。

---

## 実装メモ(共通)

- クライアント規約: data-action は `registerActions`、非クリック委譲は `registerEventBinder`
  (AGENTS.md)。`main.ts` へ関数追加禁止。
- 座標系・SVG の罠: scale(1000) group 外は不可視、`fill="none"` はヒットテスト外
  (`Docs/` 各所・pagePanelLightboxView.ts 冒頭コメント参照)。
- 実装順の想定: 課題A・トーン(別紙)→ 課題B・C(後発は先発マージ後の main を基点に)。

## 変更履歴

- 2026-07-14: 初版(ユーザーフィードバック9項目のうち項目1〜8を本書に、項目9を Feature-ScreenTones.md に分割)。
