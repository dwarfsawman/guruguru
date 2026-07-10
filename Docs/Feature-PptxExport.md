# Feature: PPTX エクスポート

Book の完成品を PowerPoint(.pptx)デッキとして書き出す機能。既存の画像一括書き出し
(`Docs/Feature-CGCollectionSuite.md` P4)エンドポイントに `format: "pptx"` を追加する形で実装した
(独自エンドポイントは新設していない)。

## 設計要点

- **API**: `POST /api/projects/:id/export-images` の `format` に `"pptx"` を追加。
  `src/server/imageExport.ts` の `parseImageExportFormat` が `"png" | "jpeg" | "pptx"` を受け付け、
  `createImageExport` は `format === "pptx"` なら `pageIds` 解決後に `src/server/pptxExport.ts` の
  `createPptxExport(project, pages, quality, pixelWidth)` へ丸ごと委譲する。
- **描画パイプラインの再利用**: 各ページは `computeExportCanvas(pixelWidth, resolvePageHeight(page, layout))`
  の解像度で `createPageLayers` + `renderMergedImage`(いずれも `openRasterExport.ts`)により平坦化する。
  PPTX への埋め込みは常に JPEG(`sharp().flatten({ background: JPEG_FLATTEN_BACKGROUND }).jpeg({ quality })`)
  — ページは Paper 層で不透明なので透過ロスの心配はない。`quality`/`pixelWidth` は
  `imageExport.ts` の `clampJpegQuality`/`clampPixelWidth` で既に clamp 済みの値を渡す。
- **循環 import 回避**: `computeExportCanvas` と `JPEG_FLATTEN_BACKGROUND` は元々 `imageExport.ts` に
  あったが、`pptxExport.ts` からも使うために `openRasterExport.ts` へ移設した(`imageExport.ts` は
  後方互換のため `computeExportCanvas` を re-export している)。`imageExport.ts` → `pptxExport.ts`
  (`createPptxExport` 呼び出し)の一方向 import のみで、`pptxExport.ts` → `imageExport.ts` は
  `import type { ImageExportResult }`(型のみ、実行時に消える)に留めてサイクルを作らない。
- **スライドサイズ**: デッキ全体で1つ。幅は `9144000` EMU(10インチ)固定、高さは先頭ページの
  `resolvePageHeight` 比から `round(9144000 × 比)` で算出し、`914400`〜`51206400` EMU
  (PowerPoint が受け付ける1辺の範囲、1〜56インチ)へ clamp する。ページごとにアスペクト比が異なる
  場合は、そのページの画像をスライド中央へ「contain」配置する(`computeSlidePicRect`。はみ出す辺を
  スライド全幅/全高に合わせ、余る辺は中央寄せでレターボックス化)。
- **戻り値**: 複数ページでも zip 化せず、常に単一 `.pptx` を返す(`ImageExportResult` 型をそのまま
  流用)。ファイル名は `${safeAsciiName(project.name, "guruguru-book")}.pptx`。

## OOXML 構成(JSZip 手組み、ライブラリ非使用)

`src/server/pptxExport.ts` が以下のパート一式を組み立てる:

```
[Content_Types].xml
_rels/.rels
docProps/core.xml, docProps/app.xml
ppt/presentation.xml (+ ppt/_rels/presentation.xml.rels)
ppt/presProps.xml, ppt/viewProps.xml, ppt/tableStyles.xml
ppt/theme/theme1.xml
ppt/slideMasters/slideMaster1.xml (+ _rels → slideLayout1, theme1)
ppt/slideLayouts/slideLayout1.xml (+ _rels → slideMaster1)
ppt/slides/slideN.xml (+ _rels → slideLayout1, ../media/imageN.jpeg) ×ページ数
ppt/media/imageN.jpeg ×ページ数
```

### ハマりどころ

- `p:sldIdLst` の `id` は **256 以上で一意**でなければならない(`256 + pageIndex` を採用)。
- `r:id` は各 `_rels` ファイルの Relationship `Id` と**厳密一致**させる必要がある
  (`presentation.xml` の `sldIdLst`/`sldMasterIdLst` ↔ `presentation.xml.rels`、
  `slideN.xml` の `a:blip r:embed` ↔ `slideN.xml.rels` の画像 Relationship)。
- **master → layout → slide の rels 連鎖を1本でも欠くと PowerPoint は「修復」ダイアログを出す**。
  各 `slideN.xml.rels` には画像の Relationship だけでなく、所属する `slideLayout1.xml` への
  Relationship も必須(スキーマ上必須。ここを省略すると開けなくなる罠)。
- `a:ext` の `cx`/`cy`(EMU)は**正の整数**であること。`Math.round` + `Math.max(1, …)` で保証する。
- `ppt/theme/theme1.xml` は `fillStyleLst`/`lnStyleLst`/`effectStyleLst`/`bgFillStyleLst` の
  それぞれに**3要素ずつ**必要(最小構成でも数を減らすと壊れる)。中身は `schemeClr val="phClr"` の
  ダミーで足りる。

## テスト

`src/server/pptxExport.test.ts`(`createImageExport(projectId, { format: "pptx" })` 経由の
E2E スタイル)で検証:

- `[Content_Types].xml` に jpeg Default と各 slide の Override が揃う
- `presentation.xml` のスライド数がページ数と一致し、`sldId` が 256 以上で一意
- `presentation.xml.rels` と `sldIdLst` の `r:id` が整合
- 各 `slideN.xml.rels` が `../media/imageN.jpeg` と `slideLayout1.xml` の両方を指し、
  media バイト列が JPEG マジック(`FF D8`)で始まる
- 単一ページでも `.pptx` 単体で返る(zip 化しない)
- `parseImageExportFormat("pptx")` が通り、不正な format 値は 400
- `p:sldSz` の `cx`/`cy` が EMU の clamp 範囲内

## クライアント

`src/client/views/imageExportModal.ts` の形式ラジオに「PPTX」を追加。JPEG 品質行
(`imageExportController.ts` の `bindImageExportEvents`)は format が `jpeg` **または** `pptx` のとき
表示する(PPTX 埋め込みが常に JPEG のため)。既定は `png` なので初期表示では品質行は非表示のまま。
`submitImageExport` の format 読み取りを3値対応にし(`readImageExportFormat`)、フォールバックファイル名
(`fallbackImageExportName`)に pptx ケースを追加、成功トーストも pptx 時は「PPTXを書き出しました。」に
変えた。
