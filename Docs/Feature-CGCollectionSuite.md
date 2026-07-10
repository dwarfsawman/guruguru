# Feature: CG集制作スイート（ページオブジェクト・テキスト・吹き出し・書き出し・コマ編集・モザイク）

## 目的

guruguru を「AI生成画像を素材に、商用CG集（DLsite/FANZA 等で頒布する画像集・漫画形式作品）を
完成品まで作れるソフト」にする。既存の Book モード＋コマ割り＋コマ内生成の上に、以下を追加する。

| フェーズ | 内容 | 状態 |
|---|---|---|
| P1 | ページオブジェクト基盤（データモデル・API・編集UI・ギズモ共通化・undo/redo） | 完了(2026-07-10) |
| P2 | テキスト（縦書き/横書き・フォント選択・自前レイアウト・グリフパス描画） | 完了(2026-07-10) |
| P3 | 吹き出し＋ボックス（形状ライブラリ・しっぽ・テキスト内包） | 完了(2026-07-10) |
| P4 | 完成品書き出し（全ページ PNG/JPEG 連番一括・ORA レイヤ反映） | 完了(2026-07-10) |
| P5 | コマ形状編集（頂点ドラッグ・分割・ガター） | 完了(2026-07-10) |
| P6 | モザイクツール（非破壊リージョン・販路規定準拠粒度） | 実装完了・監督レビュー待ち(2026-07-10、branch: p6-mosaic) |

実装は各フェーズ = 1 worktree ブランチ → レビュー → main マージ。実装者は Sonnet 5 executor、
本ドキュメントが監督（Fable 5）の指示書を兼ねる。

## 全体設計判断（フェーズ横断）

### 座標系

ページオブジェクトは既存 `PageLayout` と同じ **width-relative-top-left**（x∈[0,1]、y∈[0,page.height]、
長さの単位 = page-width）。コマ・オブジェクト・モザイクリージョンすべて同一座標系で、
`pageLayoutSvg.ts` の `scale(1000)` viewBox にそのまま乗る。

### 永続化: `pages.objects_json`（1行に JSON 配列）

- `ensureColumn("pages", "objects_json", "TEXT")` ＋ `jsonColumnNames` に `objects_json → objects` を登録。
- `asset_paste_attachments` と同じ「1行に配列」パターン。オブジェクトは1ページ数十個規模なので
  行分割は不要。保存は配列全体 PATCH（`PATCH /api/projects/:id/pages/:pageId/objects`）。
- 競合制御はなし（ローカル単一ユーザー前提、既存の流儀に合わせる）。
- プレビューキャッシュバスタ: `listPagesWithProject` の `panel_preview_version` に
  `pages.updated_at` を混ぜる（オブジェクト PATCH 時に pages.updated_at を更新）。

### 型定義: `src/shared/pageObjects.ts`（新規・純ロジック）

```ts
type PageVec = { x: number; y: number };            // page 座標
type TextStyle = {
  fontId: string;                // フォント識別子（P2 で解決。P1 は "default"）
  size: number;                  // page-width 比（例 0.03 = ページ幅の3%）
  direction: "horizontal" | "vertical";
  color: string;                 // #rrggbb
  outlineColor?: string;         // フチ（白フチ等）。無しは省略
  outlineWidth?: number;         // size 比
  lineSpacing?: number;          // 行送り倍率 既定 1.6
  letterSpacing?: number;        // 字送り倍率 既定 1.0
  align?: "start" | "center" | "end";
};
type TextContent = { text: string; style: TextStyle };

type PageObjectBase = {
  id: string; kind: string;
  position: PageVec;             // オブジェクト中心
  rotation: number;              // ラジアン (-π, π]
  // z順は配列順（先頭=背面）。order フィールドは持たない
};
type TextObject   = PageObjectBase & { kind: "text";    content: TextContent;
                                       maxWidth?: number };  // 折り返し幅（page単位）
type BalloonObject = PageObjectBase & { kind: "balloon";
  shape: "ellipse" | "rounded" | "cloud" | "jagged" | "thought";
  size: PageVec;                 // 幅・高さ（page単位）
  tail?: { tip: PageVec; width: number } | null;  // tip はページ座標（絶対）
  fill: string; strokeColor: string; strokeWidth: number;
  content?: TextContent | null };
type BoxObject    = PageObjectBase & { kind: "box";
  size: PageVec; cornerRadius?: number;
  fill: string; strokeColor: string; strokeWidth: number;
  content?: TextContent | null };
type PageObject = TextObject | BalloonObject | BoxObject;
```

- `normalizePageObjects(raw): PageObject[]` — サーバ入力検証・クライアント読込の両方で使う
  （`normalizePanelCrop` と同じ役割）。未知 kind は捨てる。数値は clamp。
- 既存 `PageLayout.balloons`/`texts` 予約フィールドは**取り込み保持用として温存**し、
  編集対象にはしない（レイアウトテンプレ由来の飾りは将来課題）。編集はすべて `page.objects`。

### ギズモ共通化（P1 で実施）

paste（`pasteObjectController`）とコマクロップ（`pagePanelLightboxController`）で同型実装が
2つあり、3例目を作る前に共通ユーティリティを抽出する:

- `src/client/svgGizmo.ts`（新規・純関数中心）:
  - `screenToSvgFactor(el: SVGGraphicsElement)` — getScreenCTM から pxPerUnit と原点を返す。
  - ジェスチャ数学: 移動デルタの座標系回し込み・中心距離比スケール・atan2 回転＋スナップは
    `pasteTransform.ts` の純関数を座標系非依存に一般化して移設 or 参照。
  - ハンドル画面基準サイズの sync ヘルパ（`syncPagePanelCropGizmo` の一般化）。
- **既存2実装の書き換えはしない**（回帰リスク回避）。新ギズモ（オブジェクト変形・頂点編集）
  だけが使う。既存の置き換えは全フェーズ完了後の掃除課題。

### 編集 UI の場所: ページ編集モードの拡張

`pagePanelLightboxController` の lightbox を「ページ編集画面」に発展させる。上部にモードタブ:

- **コマ** — 既存のコマ選択/クロップ編集（無変更）
- **オブジェクト** — P1〜P3。オブジェクトの追加/選択/変形/削除/z順/プロパティパネル
- **コマ枠** — P5。頂点編集・分割
- **モザイク** — P6。リージョン編集

state は `pagePanelLightbox` に `mode` を足す。レイアウトを持たないページ（1枚絵ページ）でも
オブジェクト/モザイクモードは開けるようにする（CG集は1枚絵＋文字が主流のため。
`page.layout` が無い場合は代表アセットのアスペクト比を page とみなす）。

### undo/redo

`paintHistory.ts` と同型の統合スタックを `pageObjectHistory.ts`（純ロジック）に:
`{ objects: PageObject[]; selectedId: string | null }` のスナップショット、総数上限 50。
Ctrl+Z / Ctrl+Shift+Z（ページ編集モードが開いている間のみ奪う）。確定操作
（pointerup・プロパティ変更・追加・削除）ごとに push。保存はスナップショットと独立に
debounce PATCH（1s）＋クローズ時 flush。

### テキスト描画アーキテクチャ（P2 の核・全フェーズに影響）

**方針: 自前レイアウト＋グリフパス描画。ブラウザとサーバで同一の SVG `<path>` を生成する。**

- sharp(librsvg) の `<text>` はフォント発見が fontconfig 依存で信頼できないため、
  **エクスポートに `<text>` は使わない**。テキストは全てグリフアウトライン（`<path d=...>`）へ変換。
- フォントパーサ: **fontkit**（新規依存。TTC 対応・GSUB `vert`/`vrt2` 対応・pdfkit 実績）。
  サーバ側で動かす。クライアントへのバンドルはしない。
- **レイアウトはサーバの純ロジック** `src/server/textLayout.ts`:
  `layoutText(font, content, maxWidth?) → { glyphs: {pathD, x, y, rotation}[], bbox }`。
  縦書きは1文字ずつ位置決め:
  - `vert` 代替グリフ（「」。、ーなど）を GSUB で引く。フォントに無い場合のフォールバックは
    回転（ー・～・（）等は 90° 回転）＋平行移動（。、は右上寄せ）テーブルで補正。
  - 拗促音（ゃゅょっ等）は右上寄せ補正。
  - 行折り返し: `maxWidth`（縦書きでは最大高さ）で禁則処理（行頭禁則: 。、』」ゃっ等 / 
    行末禁則: 『「（等）付きの簡易改行。
- クライアントは編集中のみ即時プレビューが要るため、**レイアウト API** 
  `POST /api/text-layout`（body: TextContent+maxWidth, 返り: glyphs）を debounce（150ms）で叩き、
  返ってきたパスを SVG に描く。タイピング中の未確定文字間は最後のレイアウト結果＋
  カーソルのみクライアント描画。ローカルサーバなので往復は数 ms、実用上 WYSIWYG。
  結果は `(fontId, text, style)` キーでクライアント側 LRU キャッシュ。
- **永続化はソーステキスト＋スタイルのみ**（glyphs は保存しない）。エクスポート時は
  サーバが同じ `layoutText` を呼んで SVG を組み、sharp でラスタライズ → 完全一致。

### フォント管理（P2）

- フォント置き場: `dataRoot/fonts/`（ユーザーが ttf/otf/ttc を置く）＋ Windows システムフォント
  （`C:\Windows\Fonts` と `%LOCALAPPDATA%\Microsoft\Windows\Fonts`）を起動時走査。
- `GET /api/fonts` — `{ id, familyName, subfamilyName, path, source }[]`。fontkit で名前テーブルを
  読む（走査結果は DB `app_settings` にキャッシュ、mtime で無効化）。
- 既定フォント: 走査結果から Noto Sans JP → Yu Gothic → Meiryo の優先順で自動選定。
- **ライセンス注意を UI に明記**: 「画像化して頒布する場合もフォントのライセンスをご確認ください」。

### 商用書き出し（P4）

- `POST /api/projects/:id/export-images` body: `{ pageIds?, format: "png"|"jpeg", quality?,
  pixelWidth (既定 1280), naming?: "index" }` → 単ページは画像、複数ページは zip
  （`001.png`, `002.png`, ...）。openraster-export と同じ配信パターン。
- レイヤ合成順: Paper → コマ画像（既存）→ コマ枠（既存）→ **ページオブジェクト**（P1〜P3、
  配列順）→ **モザイク**（P6、最前面・必須で最後）。`createPageLayers` にレイヤ供給関数を追加し、
  ORA 出力にも同レイヤが入る（ORA ではモザイクも独立レイヤ）。
- モザイク粒度検証: 成人向け規定（1粒 ≧ 画像長辺/100 かつ ≧ 4px）を書き出し解像度で満たすよう
  ブロックサイズを自動計算。

### コマ形状編集（P5）

- 対象: `polygon`（頂点ドラッグ・辺中点への頂点追加・頂点削除）、`rect`（角/辺ドラッグ）、
  `ellipse`（中心/半径）。`path` は編集不可（表示のみ）。
- コマ分割: 選択コマの上をドラッグで直線を引く → polygon を2分割（ガター幅指定、既定は
  ページ幅の 1.5%）。分割後の新パネル id は採番、既存割り当ては面積の大きい側が引き継ぐ。
- 保存は `PATCH /api/projects/:id/pages/:pageId/layout`（layout 全体置換・normalize 済み検証）。
- 割り当て済み画像がある場合、crop は温存（コマ外接矩形が変われば cover 既定に自動リセットは
  しない。ユーザーがクロップ編集で直す方が予測可能）。

### モザイク（P6）

- **非破壊**: `pages.mosaic_json`（`ensureColumn`）に `MosaicRegion[]` を保存。
  `{ id, shape: {type:"rect"|"polygon", ...}, granularity?: number }`（granularity は
  長辺比。省略時は書き出し時に規定最小値を自動適用）。
- 編集 UI: モザイクモードで矩形ドラッグ追加・頂点編集（P5 の頂点編集を流用）・削除。
  プレビューはクライアント canvas（領域を縮小→拡大 `imageSmoothingEnabled=false`）。
- 書き出し: sharp で `extract(region bbox) → resize(小) → resize(大, kernel:"nearest") →
  polygon マスクで dest-in → composite`。プレビュー（preview.png）にも適用する。

## フェーズ別受け入れ基準

各フェーズ共通: `bun run typecheck` / `bun test` / `bun run build` グリーン、純ロジックには
併置ユニットテスト、ヘッドレス API 検証（隔離 `GURUGURU_TEST_DATA_DIR`）、設計との差分は
本ドキュメントに追記。**コミットは worktree ブランチ、main へのマージは監督が行う。**

- **P1**: pageObjects 型+normalize+テスト / objects_json 永続化 / PATCH API（不正入力 400）/
  ページ編集モードタブ / box オブジェクトの追加・選択・移動/拡縮/回転ギズモ・削除・z順 /
  undo/redo / debounce 保存＋再読込復元 / preview.png と ORA に box が反映
  （テキストは P2、吹き出し形状は P3 なので P1 は box のみで貫通させる）。
- **P2**: fontkit 導入 / フォント走査+一覧 API / text-layout API（横書き・縦書き・折り返し・
  禁則・約物・拗促音）/ TextObject 編集（追加・インライン入力・スタイルパネル: フォント/
  サイズ/色/フチ/行間/揃え）/ box・balloon への content 内包描画 / エクスポート一致。
  縦書きレイアウトの純ロジックにはゴールデンテスト（座標スナップショット）。
- **P3**: balloon 5形状 + しっぽ（tip ドラッグ）/ 白フチ（外側 stroke）/ content テキスト
  内包＋自動折り返し（形状内接矩形）/ プロパティパネル / エクスポート一致。
- **P4**: export-images API（png/jpeg・解像度・zip 連番）/ UI（Book 画面に「画像書き出し」
  ダイアログ: 対象ページ・形式・解像度）/ オブジェクト＋モザイクを含む合成 /
  ORA にオブジェクトレイヤ追加。
- **P5**: 頂点編集（polygon/rect/ellipse）/ 頂点追加・削除 / コマ分割（ガター付き）/
  layout PATCH API / 割り当て温存 / プレビュー更新。
- **P6**: MosaicRegion モデル+テスト / 編集 UI（矩形+polygon）/ クライアントプレビュー /
  sharp 書き出し（粒度規定の自動下限）/ preview.png 反映 / ORA 独立レイヤ。

## 変更履歴

- 2026-07-10: 初版（Fable 5 監督、要件確定: P1〜P6 全部・成人向けモザイク込み・縦書き自前レイアウト）。各フェーズの完了時に、実装での設計差分をここへ追記すること。
- 2026-07-10: P1 完了・main マージ（merge 8fbc5ef）。設計からの差分:
  - PATCH の入力検証は「`objects` が配列でなければ 400」のみとし、要素単位の型崩れ・未知 kind は
    `normalizePageObjects` が黙って破棄/clamp（`normalizeGuruguruLayout`/`normalizePanelCrop` の既存流儀に合わせた）。
  - 1枚絵ページの編集入口はページカードの新アイコンボタン（`iconLayers`）。既存のカードクリック挙動
    （コマ割り=コマ選択 lightbox、1枚絵=zoom）は無変更。
  - **既知のギャップ**: レイアウト無しページのグリッドサムネは代表アセット直 URL のままで、オブジェクトが
    映らない（preview.png/ORA には反映される）。P2〜P4 のどこかで preview.png 経由に統一するか要判断。
  - レビュー修正4件: sync 側の回転ハンドル反転漏れ（view の bounds が margin=2 で反転判定が死んでいた件も
    修正、可視域 0..1×0..pageHeight に統一）、PATCH 応答によるドラフト巻き戻し防止（タイマー/ドラッグ非活動時
    のみ反映）、入力欄フォーカス中の Ctrl+Z ガード、flush を Promise 化しクローズ時は完了後に dirty 判定→
    `reloadBookPages()`（in-flight PATCH も待つ）。
- 2026-07-10: P2 完了・main マージ（merge d9d0e42）。設計からの差分:
  - `FontMetricsProvider` に `ascent`/`descent` を追加（ベースライン配置・回転軸計算に必要）。
  - fontkit は型定義が無いため `src/server/fontkit.d.ts` を手書き。TTC は `openSync().fonts[i]`、
    `vert` は `font.layout(char, ["vert"])` でグリフ id が変わった場合のみ採用（実フォントで動作確認済み。
    名前テーブルが Uint8Array を返す壊れフォント対策の `toDisplayString` ガードあり）。
  - box/balloon content の折り返しパディングは `CONTENT_PADDING_RATIO = 0.12`（新定数）。
  - サーバ export のオブジェクト回転は P1 box と同じピクセル空間回転（キャンバスとページのアスペクト比が
    ズレる場合のみプレビューと微差。P1 由来の既知の割り切り）。
  - balloon.content のエクスポート描画は先行実装済み（P3 で編集 UI が付くまで実質不活性）。
  - レビュー修正2件: `textSvg.ts` の数値整形を有効数字8桁へ（絶対丸めだと unitsPerEm=2048 フォントの
    emScale が潰れグリフが約30%縮む実バグ。ピクセル実測で修正確認）、フォント select 先頭に「既定フォント」
    オプション追加（fontId="default" の表示化け対策）。
  - 監督ブラウザ検証済み: 縦書き列送り・横書き切替・白フチ・フォント切替・textarea 編集・保存。
- 2026-07-10: P3 完了・main マージ（merge a8fd72e）。設計からの差分:
  - **`BalloonTail.tip` をページ絶対座標→オブジェクトローカル座標（中心原点・回転前）に変更**（移動/回転で
    しっぽが千切れないため。normalize は ±2 に clamp）。
  - 本体+しっぽの継ぎ目消し: しっぽ stroke → 本体 fill+stroke → しっぽ fill の3層重ね
    （`renderBalloonSvg` として共有、クライアント/エクスポート同一コード）。thought はしっぽを縮小円列で表現。
  - しっぽの本体境界交点は全形状とも楕円近似（cloud/jagged の実輪郭とは微差、実用上問題なし）。
  - 吹き出し自体の外側白フチは P3 スコープ外（テキストの outline は既存）。
  - cloud/jagged の凹輪郭でクリックが抜けないよう、ヒット判定は bbox の透明 rect に集約
    （balloon 形状パスは pointer-events:none）。
  - P2 の取りこぼし修正を同梱: box/balloon の content グリフがライブ編集キャンバスに描画されていなかった
    （エクスポート/プレビューのみだった）のを `renderInlineContentGlyphs` 抽出で解消。
  - 監督ブラウザ検証済み: 吹き出し追加・5形状切替・しっぽトグル+tip ドラッグ（ローカル座標保存）・
    content テキスト編集・保存復元。
- 2026-07-10: P4 完了・main マージ（merge 981e742、監督レビュー済み）。設計からの差分:
  - `POST /api/projects/:id/export-images`(`src/server/imageExport.ts` 新規)。既存の
    `openRasterExport.ts` の `createPageLayers`/`renderMergedImage`/`requireProject`/`loadExportPages`/
    `safeAsciiName` を `export` して再利用し、新規に `resolvePageHeight(page, layout)`(既存の
    `appendObjectsLayer` 内インライン計算を抽出。ORA/preview.png の挙動は不変)を追加した。
    `createPageLayers` は元々 `canvas: {width,height}` を引数に取る設計だったため、P4 は
    「pixelWidth × ページ高さ比(`resolvePageHeight`)」で計算した専用解像度の `canvas` を渡すだけで、
    ORA 用のコード変更なしに任意解像度の書き出しに対応できた。
  - JPEG は `sharp().flatten({background:{r:255,g:255,b:255}}).jpeg({quality})` でフラット化。ただし
    既存の Paper レイヤー(不透明・ベージュ `#f5f2ea` 相当)が常に全面を覆うため、実際に白背景が
    透けて見えるケースは無い(四隅は透過なし・Paper色で統一。preview.png/ORA と見た目を揃えるための
    意図的な据え置き。将来 Paper 無しの合成が生まれた場合の保険として flatten は維持)。
  - ファイル名は `page_index+1` の3桁ゼロ詰め(`001.png`/`002.jpg`、タイトルなし。ORA の
    `pageFileBase`とは別関数 `pageImageFileBase` を用意し、ORA 側の命名は無変更)。zip 名は
    `<プロジェクト名サニタイズ>_images.zip`。
  - UI: Book 見出しに「画像書き出し」ボタン(全ページ対象)、既存のページ選択モードのツールバーに
    「選択ページを画像書き出し」ボタンを追加(選択モードは P1 以前から存在、流用)。ダイアログは
    `.workflow-modal`/`.workflow-dialog`(レイアウトテンプレピッカー踏襲、幅だけ
    `shortcuts-help-dialog` 同様に上書き)。形式(PNG/JPEG ラジオ)・JPEG品質(1-100 スライダー、
    JPEG選択時のみ表示)・解像度(プリセット1280/1600/2048 + 自由入力)は `#image-export-form` から
    `readForm`(FormData)で読み、state との双方向同期は持たない(プロジェクト作成フォームの
    既存パターンを踏襲)。ダウンロードは openraster-export と同型の fetch→blob→`<a download>`。
    循環 import を避けるため、共有ヘルパ(`responseErrorMessage`/`filenameFromContentDisposition`/
    `downloadBlob`)は `bookController.ts` から `src/client/downloadUtils.ts` へ切り出し、
    両 controller から参照する形にリファクタした(ORA 側の挙動は不変)。
  - オブジェクト/モザイクの合成順コメントは `imageExport.ts` の `renderPageImage` に記載済み(P6 未実装、
    `createPageLayers` にレイヤを足すだけで平坦化ロジック側の変更は不要になる設計)。
  - **既知のバグ修正1件(実装中に発見)**: JPEG品質スライダー行に付けた `hidden` 属性が
    `.range-control{display:grid}` に(同 specificity・カスケード順で)上書きされ、PNG選択時にも
    常時表示されてしまっていた。`.image-export-quality-row[hidden]{display:none}` を追加して解消
    (ブラウザ検証で発覚)。
  - ORA へのオブジェクトレイヤ追加は P1〜P3 で実施済みのため、P4 では変更なし(設計書の記載どおり)。
  - 実施者によるヘッドレス API 検証(zip連番・解像度・quality・4xx)に加え、preview_start
    (`guruguru-preview-p4-export-images` エントリ追加済み)でのブラウザ動作確認も実施
    (全ページ/選択ページ導線・PNG⇄JPEG切替・解像度プリセット・書き出し→トースト→モーダル自動close)。
    監督による最終レビューは別途。
- 2026-07-10: P5 完了・main マージ（merge 598a871、監督レビュー済み）。設計からの差分・補足:
  - **共有純ロジック `src/shared/panelShapeEdit.ts`**(新規): `panelShapeToPolygon`(rect は4頂点+cornerRadius
    破棄、ellipse は16頂点近似、polygon はコピー、path は null)/ `movePolygonVertex`(x∈[0,maxX]・
    y∈[0,maxY] へ clamp、NaN は元の値を維持)/ `insertPolygonVertex`(辺中点挿入)/
    `removePolygonVertex`(3頂点未満になる削除は null で拒否)/ `polygonArea`(shoelace)/
    `splitPanelByLine`。分割は「頂点上に交点が乗る」「片方が頂点hitでもう片方が辺hit」等の退化ケースに
    対応するため、頂点hit/辺hitを統一した拡張点列(`ExtPoint[]`)を作ってから2箇所の hit index で
    分割するアプローチにした(交点がちょうど2つでない/分割後3頂点未満/退化直線は null)。ガターは
    直線の法線方向へ両チェーンをそれぞれ自分の内側点の平均符号方向に半分ずつオフセット。
    ユニットテスト20件(rect/ellipse→polygon、頂点操作の境界値、分割の交点/ガター/頂点上交点/面積、
    退化ケース)。
  - **`pageLayout.ts` に軽量な再検証 `normalizeEditedPageLayout`**(新規、`normalizeGuruguruLayout` とは別)
    を追加: page.aspectRatio/height の存在チェック、panels 各要素の shape 型/数値検証(既存
    `normalizePanelShape`/`normalizeFrame` を再利用)、panel id 一意性(衝突時は連番サフィックスで
    回避。黙って破棄すると編集中パネルが消えるため)。panels が1つも残らなければ null(サーバ側で400)。
    balloons/texts/source は素通しで保持。あわせて `clonePageLayout`(JSON 経由のディープコピー)も追加。
  - **サーバ `PATCH /api/projects/:id/pages/:pageId/layout`**(`src/server/pages.ts` の `updatePageLayout`)。
    `normalizeEditedPageLayout` で検証(null なら400)、消えた panel id の `page_panel_assignments` を
    削除(残った id の割り当て/crop は行を触らないのでそのまま温存)、`pages.updated_at` 更新。
  - **クライアント「コマ枠」モードタブ**(P1 のモードタブ機構に追加、`mode: "panels"|"objects"|"shapes"`):
    - 新規 `src/client/panelShapeController.ts`: 選択/多角形変換/頂点ドラッグ・辺クリックでの頂点追加・
      ダブルクリック(または選択+Delete)での頂点削除/分割モードのトグル・ドラッグ・確定を扱う。
      保存は 1s debounce PATCH + lightbox クローズ時 flush(`pageObjectsController.ts` と同型の
      `resetShapeEditSession`/`flushShapeEditSave`/`consumeShapeEditDirtyFlag`)。**分割だけは debounce
      を待たず即時 PATCH**する -- 新パネル id(`panel_N` 採番)はサーバに保存されて初めて存在するため、
      既存割り当ての移行(`PATCH .../panels/:id/assignment`)より前に layout PATCH の完了を await する
      必要がある(ヘッドレス検証でこの順序要件が実際に効くこと -- 保存前は新 id への assignment PATCH が
      400、保存後は 200 になること -- を確認済み)。移行先は面積の大きい側(`polygonArea` で比較)。
    - 頂点ドラッグの座標変換は `svgGizmo.ts` に追加した `getInverseStageTransform`(画面px→ステージ座標の
      逆変換。既存のギズモは中心固定のデルタ計算だけで済んでいたため、分割線ドラッグの絶対位置取得で
      初めて逆変換が必要になった)を使う。
    - 表示(`views/pagePanelLightboxView.ts` に追加): 選択パネルが polygon なら頂点ハンドル+辺中点
      マーカーを表示(分割モード中は非表示)、rect/ellipse なら「多角形に変換して編集」ボタン、path なら
      「このコマ形状は編集できません」。分割モードはドラッグ中の直線プレビュー(`<line>`)を表示。
    - **既知の割り切り**: 「コマ」モードは `page.layout`(state.book 側)をそのまま読むため、コマ枠編集の
      debounce 保存が完了するまでの間にタブを切り替えると一時的に旧形状が見える(保存完了後は
      `state.book` 側にも反映して同期する)。実用上は保存完了(1秒以内)を待てば一致する。
    - **undo/redo は P5 のスコープ外**(オブジェクトモードの `pageObjectHistory.ts` とは独立に持たない
      仕様どおり)。
  - ヘッドレス API 検証(隔離 `GURUGURU_TEST_DATA_DIR`、bun で `src/server/index.ts` を直接起動):
    layout PATCH の正常置換・0パネルで400・消えたパネルの割り当て削除・残ったパネルの crop 温存・
    分割後の新パネル id への割り当て移行の順序要件(保存前400→保存後200)・不正 layout(page情報欠落)で
    400・編集後も preview.png が描画できること、の27アサーション全通過。
  - ブラウザ検証(実施者、`guruguru-preview-p5-panel-shape` エントリ追加): four-grid テンプレでページ作成
    → コマ枠タブ切替 → コマ選択 → 多角形に変換 → 頂点ドラッグ(斜めカットを確認・再オープンで永続化確認・
    「コマ」タブでも同じ形状に追従することを確認)→ 辺クリックで頂点追加 → ダブルクリックで頂点削除 →
    分割モードでドラッグ → 2コマに分割されガター込みで反映(ページ一覧のプレビューにも反映)されることを
    確認。コンソールエラーなし。監督による最終レビュー・ブラウザ確認は別途。
- 2026-07-10: P6 実装完了(branch `p6-mosaic`、監督レビュー待ち)。設計からの差分・補足:
  - **`src/shared/mosaicRegion.ts`**(新規): `MosaicRegion`/`MosaicShape`(rect: `bounds:[x,y,w,h]` /
    polygon: `points`)、`normalizeMosaicRegions`(型崩れ/頂点3未満のpolygon/非正サイズのrect破棄・
    数値clamp・id重複は`_dup`・上限100件、`normalizePageObjects`と同じ流儀)、`mosaicBlockSizePx`
    (`max(4, ceil(長辺/100), granularity ? round(長辺*granularity) : 0)` で規定下限を一元管理)、
    `regionBoundsPage`、矩形コーナー/辺ハンドルの純粋なリサイズ関数 `resizeMosaicRectBounds`
    (設計書には無い追加 -- P5 の `panelShapeEdit.ts` に倣い、UI 操作のジオメトリ計算を純関数化してテストした)。
    polygon の頂点編集(移動/辺への挿入/削除)は **P5 の `panelShapeEdit.ts` の関数をそのまま再利用**
    (`movePolygonVertex`/`insertPolygonVertex`/`removePolygonVertex` は座標系に依存しない汎用実装だったため、
    複製せず import して使った)。ユニットテスト22件(`mosaicBlockSizePx`の規定下限クランプ含む)。
  - **DB/API**: `pages.mosaic_json` + `jsonColumnNames`(`mosaic_json`→`mosaic`)。
    `PATCH /api/projects/:id/pages/:pageId/mosaic`(`updatePageMosaic`、body `{regions}` が配列でなければ
    400、`updatePageObjects` と同型)。
  - **サーバ書き出し(`openRasterExport.ts`)**: `createPageLayers` の最後に `appendMosaicLayer` を追加
    (レイアウト有り/無し両方の分岐末尾)。モザイク化には「そのページの下層(Paper〜Objects)の合成結果」が
    要るため、`appendMosaicLayer` 内で一度 `renderMergedImage(layers, canvas)` を呼んで下層マージ画像を得る
    (createPageLayers 自体の構造は変更せず、末尾に1関数呼び出しを足すだけで済んだ)。
    **設計書は「sharp の resize(縮小)→resize(拡大, kernel:nearest)」を示唆していたが、実装では
    `pixelateRegionBuffer` として生ピクセル(raw buffer)を直接 blockSize×blockSize の格子で平均色に
    量子化する方式にした** -- resize→resize は非整数倍率のスケーリングで格子境界が ±1px ずれ得て
    「1粒 ≧ 規定値」を全ブロックで厳密に保証できない懸念があったため、格子をリージョン bbox の
    左上に直接アンカーする自前量子化に変更した(端の欠けブロックのみ規定未満になり得るが、bbox 境界の
    必然的な端数でありモザイク規定違反ではない)。形状マスク(`renderMosaicMaskSvg`、rect/polygon)は
    `dest-in` で合成(既存 `renderShapeMaskSvg` と同じパターン)。ORA は `createPageLayers` を共有するため
    追加コード無しで `Mosaic` レイヤーが独立レイヤーとして出力される。
  - **クライアント「モザイク」モードタブ**(4つ目、レイアウト無しページでも表示。P1のモードタブ機構に
    "mosaic" を追加): 新規 `src/client/pageMosaicController.ts`。矩形はドラッグで追加(`pointerdown`→
    `pointermove`→`pointerup`)、多角形はクリックで頂点追加→ダブルクリックまたは始点近傍クリック
    (`MOSAIC_CLOSE_POLYGON_THRESHOLD`)で確定。ダブルクリックの2発目クリック(`event.detail>=2`)は
    頂点追加をスキップし、`dblclick` イベント側で確定する(`handlePagePanelClick` の detail>=2 ガードと
    同じ考え方)。選択中リージョンの編集は rect が4隅(自由リサイズ)+4辺(1軸リサイズ)ハンドル、polygon が
    P5 と同じ頂点ドラッグ/辺クリックでの頂点追加/ダブルクリックでの頂点削除。座標変換は全て
    `getInverseStageTransform`(画面px→ステージ絶対座標)で統一し、P5のような delta 方式は使わなかった
    (分割線ドラッグと同じ理由でシンプルになる)。granularity は「粒度を指定」チェックボックス+数値入力
    (未指定 = 自動で規定最小値、と明記)。ライブの canvas ピクセル化プレビューは監督決定により省略し、
    半透明ハッチ塗り+枠のみ表示。保存は1s debounce PATCH + lightbox クローズ時 flush(既存2モードと同型)。
    **undo/redo は P5 と同様スコープ外**。
  - **実装中に見つけたバグ1件・その場で修正**: ブラウザ検証中、頂点のダブルクリックで削除されず
    (ダブルクリックが常に「多角形確定」ロジックだけを見ていて、非追加モード中の頂点削除処理が
    `handleMosaicDblClick` に無かった)。ツールバーのヒント文言(P5から流用)は「ダブルクリックで頂点削除」を
    謳っていたため、`handleMosaicDblClick` に非追加モード時の頂点削除分岐を追加して解消(修正後、実ブラウザで
    5頂点→4頂点への削除を確認)。
  - ヘッドレス検証(隔離 `GURUGURU_TEST_DATA_DIR`、bun で `src/server/index.ts` を直接起動、実測値):
    レイアウト無しページに box オブジェクトで市松模様(8x8、square=0.01 = `PAGE_OBJECT_MIN_SIZE` 下限)を
    4箇所作り、rect region(granularity=0.001)・polygon region(三角形)・rect region(granularity 未指定)・
    無指定コントロール領域を配置して `export-images`(pixelWidth 2048)を検証。
    実測: canvas 2048×2896、regulation 最小ブロックサイズ = `max(4, ceil(2896/100))` = **29px**。
    (a) granularity=0.001 と granularity 未指定の両方で、リージョン内は29px四方のブロックへ一様量子化
    (ブロック内部サンプル一致・ブロック間で色が変化・黒白の平均であるグレー系ブロックが実在)を確認、
    (b) granularity=0.001(規定を大きく下回る値)でもブロックサイズが29pxのまま(規定の下限でクランプされ、
    より小さくならない)ことを確認、(c) polygon(三角形)region で bbox 四隅のうち三角形の外側にあたる
    2隅が元の市松模様のまま(非モザイク、`255,255,255`/`0,0,0`)、三角形内側は `156,155,155` 等のグレーへ
    量子化されていることを確認、(d) ORA の `stack.xml` に `name="Mosaic"` レイヤーが含まれることを確認、
    (e) `regions` が配列でない PATCH が 400 になることを確認。preview.png もモザイク込みで生成できることを
    確認(全項目 PASS)。
  - ブラウザ検証(実施者、`guruguru-preview-p6-mosaic` エントリ追加): レイアウト無しページ・レイアウト有り
    ページの両方でモザイクタブを開き、矩形追加(ドラッグ)・矩形コーナー/辺ハンドルでのリサイズ・削除・
    多角形追加(クリック連打+ダブルクリックで確定)・頂点ドラッグ(範囲clamp確認)・辺クリックでの頂点追加・
    ダブルクリックでの頂点削除(上記バグ修正後に確認)・Delete キーでのリージョン削除・粒度チェックボックス+
    数値入力・ページ再読込後の永続化(live-reloadによる意図しないフルリロードでも図らずも実証)・
    レイアウト有りページでのページ一覧プレビュー(`preview.png?v=...`)へのクローズ後反映(タイムスタンプ更新
    +サムネイル画像の変化を確認)を確認。コンソールエラーなし。監督による最終レビューは別途。
