# Feature: CG集制作スイート（ページオブジェクト・テキスト・吹き出し・書き出し・コマ編集・モザイク）

## 目的

guruguru を「AI生成画像を素材に、商用CG集（DLsite/FANZA 等で頒布する画像集・漫画形式作品）を
完成品まで作れるソフト」にする。既存の Book モード＋コマ割り＋コマ内生成の上に、以下を追加する。

| フェーズ | 内容 | 状態 |
|---|---|---|
| P1 | ページオブジェクト基盤（データモデル・API・編集UI・ギズモ共通化・undo/redo） | 未着手 |
| P2 | テキスト（縦書き/横書き・フォント選択・自前レイアウト・グリフパス描画） | 未着手 |
| P3 | 吹き出し＋ボックス（形状ライブラリ・しっぽ・テキスト内包） | 未着手 |
| P4 | 完成品書き出し（全ページ PNG/JPEG 連番一括・ORA レイヤ反映） | 未着手 |
| P5 | コマ形状編集（頂点ドラッグ・分割・ガター） | 未着手 |
| P6 | モザイクツール（非破壊リージョン・販路規定準拠粒度） | 未着手 |

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
