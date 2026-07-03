# 画像ペイントツール

- ステータス: 設計（未着手）
- 最終更新: 2026-07-02

## 概要

アセット詳細モーダルで画像の上に直接ペイントし、結果を**新規アセットとして保存**して次の生成（img2img）の入力に使えるようにする。基本色パレット + 任意カラー選択 + スポイト付き。元画像は書き換えない（非破壊）。

## ユーザー確認済みの決定事項

- 描いた結果は新規アセットとして保存（元画像は残す）

## 現状の土台（調査結果）

- アセット詳細モーダル（`.preview-modal`）にはマスク編集モード（`state.maskEditMode`、`toggle-mask-editor`）があり、`#previewImage` の上に natural size の `#maskCanvas` を重ねる構造（`renderPreviewMedia` `assetModal.ts:82-91` + `syncAssetModalMaskCanvas` `main.ts:1702-1748`）が確立している
- ストローク描画・座標変換は共有 helper がある: `paintStroke`（`maskCanvas.ts:106-129`、現状 **strokeStyle 白固定**）、`pointerToMaskCanvasPoint`（`maskCanvas.ts:146-154`、zoom/pan 自動吸収）
- レイヤーは `maskLayerCache: Map<assetId, MaskLayerSet>`（`main.ts:138`）として offscreen canvas を再描画をまたいで保持するパターンがある
- **カラーピッカーはアプリに存在しない**（`input[type=color]` は 0 件。色関連はツリー hue と Mermaid テーマのみ）
- **画像アップロード API が既にある**: `POST /api/projects/:projectId/source-assets`（`createSourceAsset` `sourceAssets.ts:12-109`）。`dataUrl`（PNG/JPEG/WebP、`decodeImageDataUrl` `uploadDataUrl.ts:7-31` で検証、`maxSourceImageBytes` = **16MB** `uploadDataUrl.ts:4`。dataUrl 文字列長の事前チェックもあり超過は 413）を受け、`generationMode='manual_upload'`・`status='completed'` の新規 round + `status='selected'` の asset を作成する。クライアント側の呼び出し例は `uploadSourceAsset`（`main.ts:1140-1208`）
- 現状 `createSourceAsset` は `parentAssetId: null` / `relationType: "manual"` 固定（`sourceAssets.ts:46-47`）→ 保存結果はツリー上の新規 root になる

## 設計

### モードと配置

- アセット詳細モーダルに `state.paintEditMode` を新設（`state.maskEditMode` と同列・**相互排他**: 片方を ON にしたらもう片方は OFF）。入口はマスク編集ボタン（`toggle-mask-editor`、`assetModal.ts:108-114`）の隣に `toggle-paint-editor` ボタン
- マスク/ポーズはタブ（inpaint 文脈、`Feature-PoseControlNet.md`）、ペイントは画像加工という別文脈なので、タブには入れず独立モードとする
- レイアウトはマスク編集の 3 カラム grid（`.mask-editor-layout`、`styles.css:1826-1836`）を流用し、左サイドバーにペイントツールパネル、中央に `#paintCanvas`（natural size、`#maskCanvas` と同じ重ね方）

### レイヤーと描画

- `paintLayerCache: Map<assetId, HTMLCanvasElement>`（natural size 1 枚。`maskLayerCache` と同型）。元画像には触らず、ペイントはこのレイヤーにのみ描く
- `paintStroke` を **color 引数付きに拡張**（`paintStroke(canvas, from, to, brushSize, compositeOperation, color = "rgba(255,255,255,1)")`）。color は **strokeStyle と fillStyle の両方**に適用する（始点=終点の単点タップは `arc` + `fill()` で描かれるため。`maskCanvas.ts:116-121`）。マスク側の呼び出しは既定値で従来挙動不変
- ツール: **ブラシ**（選択色で source-over）/ **消しゴム**（ペイントレイヤーのみ destination-out）/ **スポイト**
- ブラシサイズ: マスクと同じ range 1〜256（`assetModal.ts:271-274` の UI 流用）
- 描画パスは `Fix-MaskPenLag.md` の rAF + `getCoalescedEvents` バッチを**最初から適用**する（同修正を先行実装しておく前提）

### カラー UI

- 基本色パレット: 固定 swatch 12 色程度（黒・白・グレー・赤・橙・黄・緑・シアン・青・紫・ピンク・茶）
- 任意カラー: `<input type="color">`（アプリ初。change で選択色に反映）
- 最近使った色: 最大 8 個の swatch（draft に保持）
- 選択状態は `PaintDraft`（新規 `src/client/paintTypes.ts`）: `{ color, brushSize, eraser, recentColors, zoomScale, panOffset }` を `state.paintDrafts: Record<assetId, PaintDraft>` で保持

### スポイト

- スポイトツール選択中のクリックで、**元画像 + ペイントレイヤーの合成結果**から色を拾う: offscreen canvas に `#previewImage`（naturalサイズ）→ ペイントレイヤーの順で合成し、`getImageData(x, y, 1, 1)` で採色 → 選択色 + 最近使った色へ反映
- 座標は `pointerToMaskCanvasPoint` でズーム中も正確
- 画像は自サーバ配信（same-origin）なので canvas taint の問題なし
- ショートカット: ブラシ中 `Alt` 押下で一時スポイト（一般的なペイントツール慣習）。keydown 一元ハンドラ（`main.ts:423-477`）に追記、`isTextEntryTarget` スキップは既存踏襲

### Undo

- ストローク開始時にペイントレイヤーの snapshot（canvas コピー）をリングバッファへ積む。**上限 5**（4K 画像で 1 枚 ~33MB、2048px で ~17MB のため控えめに）。`Ctrl+Z` で 1 ストローク戻す
- マスク編集には undo が無い（調査済み）が、ペイントは誤描画のダメージが大きいため最小限の undo を初期実装に含める

### 保存（新規アセット化）

1. 「新規アセットとして保存」ボタン → 元画像 + ペイントレイヤーを offscreen 合成 → `canvas.toDataURL("image/png")`
2. `POST /api/projects/:id/source-assets` へ送信（`uploadSourceAsset` `main.ts:1140-1208` と同じ応答処理: 返ってきた asset を親画像に設定して img2img draft を組む）
3. ファイル名は `paint_{元assetId}_{連番}.png` など由来が分かる形式
4. 保存成功後はペイントレイヤーをクリアして paintEditMode を抜ける（描き続けたい場合を考慮し、クリアの要否は実装時に確認）

### ツリー上の親子付け（第 2 段・任意）

現状の `createSourceAsset` では保存結果が root round になり、元画像との関係がツリーに残らない。第 2 段として API を拡張する。**ポイント: ツリー構造は `generation_rounds.parent_round_id` だけで決まる**（クライアントは `round.parentRoundId` で forest を構築 `iterationTree.ts:44-49`。`asset_parents` はサーバが返すもののクライアントは未使用）ため、以下がすべて必要:

- body に `parentAssetId` を追加し、**INSERT の `parent_round_id` に親 asset の `round_id` を設定**する（現状は NULL ハードコード `sourceAssets.ts:52-55`。`createGenerationRound` の `rounds.ts:102` と同様）
- `branchAssignmentForRound`（`roundBranches.ts:12-47`）に親を渡して枝色を引き継ぐ。あわせて現状 `branch_key` に `asset:${assetId}` をハードコードしている点（`sourceAssets.ts:64`）を、返却された `branch.key` を使う形に直す
- `asset_parents` に `relationType: "retouch"`（`ParentRelation` への追加）で記録（将来の表示用メタデータ。これ単体ではツリーに現れない）
- 初期実装は現行 API のまま（root 扱い）で出す

## 実装フェーズ（ブランチ: `feature/paint-N-<slug>`）

1. `paintStroke` の color 引数化（マスク挙動不変の確認テスト付き）+ `PaintDraft` 型 + `paintLayerCache`
2. モード切替 + ツールパネル UI（パレット / type=color / ブラシ・消しゴム / サイズ）+ 描画（rAF バッチ）
3. スポイト + Alt 一時スポイト + 最近使った色
4. Undo（スナップショットリングバッファ + Ctrl+Z）
5. 保存 → source-assets POST → img2img draft 接続
6. （任意）親子付け API 拡張

各フェーズで: `npm run typecheck` / `npm test` / `$env:GURUGURU_TEST_DB='1'; npm run check` / `git diff --check`。UI は 1680x920 viewport、テスト起動は非 5177 ポート + `GURUGURU_TEST_DB=1`。

## 変えないこと

- 元画像ファイル・既存アセットの内容（非破壊）
- マスク編集の描画挙動（`paintStroke` の既定値で白固定を維持）
- `source-assets` API の既存フィールドの意味・検証（`decodeImageDataUrl` の MIME/サイズ検証をそのまま通す）

## 未決事項

- `maxSourceImageBytes` は 16MB（`uploadDataUrl.ts:4`）。4K フルカラー PNG は超え得るため、JPEG フォールバック or 上限引き上げの要否を実運用で判断
- 保存後にペイントレイヤーを残すか消すか（連続レタッチのワークフロー次第）
- ツリー親子付け（`relationType: "retouch"`）をどのタイミングで入れるか

## 変更履歴

- 2026-07-02: 起票。新規アセット保存方式（ユーザー確認済み）を反映した初版。
