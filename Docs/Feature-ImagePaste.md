# 画像貼り付け(Paste & Transform)機能

- ステータス: 設計(未着手)
- 最終更新: 2026-07-06

## 概要

アセット詳細モーダルのペイント/マスク編集エリアに画像を**ドラッグ&ドロップ**(または Ctrl+V / ファイル選択 / アプリ内サムネイルの D&D)で貼り付け、**移動・回転・拡大縮小**できる。貼り付けた画像は**元画像を書き換えない「添付オブジェクト」としてアセットに紐づけて永続化**され、**ダブルクリックでいつでも再選択・再変形・削除・重ね順変更が可能**。プロジェクトを開き直しても配置は復元される。

img2img 生成時は**保存操作なしで**、クライアントが「元画像+ペイントレイヤー+添付オブジェクト」を合成した画像を生成リクエストに載せ、サーバがファイル化して ComfyUI へ送る(マスクの `maskDataUrl` → `maskPath` と同一パターン)。**ツリー上の親は元画像のまま**で、合成結果は生成ラウンドの入力素材として記録される — 「親ノードを変更せず、エッジに添付画像を載せる」モデル。

## 設計の経緯(3案比較とユーザー決定)

独立設計 3 案を 2 レンズで審査(A: 最小統合=確定焼き込み式 / B: 非破壊オブジェクトレイヤー / C: UX最優先)。当初 A 骨格を推奨 → **「ダブルクリックで素材を再選択したい」要望で B(非破壊)を採用** → さらに**「保存操作を不要にし、生成時に合成。元画像は残し、エッジに添付するイメージ。配置は開き直しても復元。添付はどかせる」という要望で、添付の永続化+生成時合成モデルへ改訂**(いずれも 2026-07-06 決定)。

前版からの主な変更点:

| 項目 | 前版(B案ベース) | 本版 |
|---|---|---|
| 保存操作 | `paint-save` で新規アセット化が出口 | **不要**。生成ボタンだけで合成→生成 |
| ツリー | 合成結果が新規アセットノードになる | **親は元画像のまま**。合成はラウンドの入力素材として保存 |
| 配置の寿命 | クライアントメモリ(モーダル再オープンまで) | **サーバ永続化**。プロジェクト開き直しで復元 |
| サーバ変更 | なし | **追加のみの拡張**(新テーブル・新エンドポイント・生成リクエストの新フィールド) |

## 現状の土台(調査で確認済みの事実)

- ペイント編集(`state.paintEditMode`)は natural-size の `#paintCanvas` を `#previewImage` に重ね、真実は module ローカルの `paintLayerCache`。再レンダー後は render 末尾の `syncAssetModalPaintCanvas()`(`main.ts:592`)が毎回復元
- 座標変換は `pointerToMaskCanvasPoint`(`maskCanvas.ts`)が fit×zoom×pan を rect 比で自動吸収。**成立条件は「`.mask-zoom-stage` の CSS transform が translate+scale のみ」**(回転を CSS に入れない)
- pointer 分岐チェーン(`main.ts:420-438`): pose → mask → workflowDiagram → ボタンフィルタ → paint → maskStroke。keydown は Escape カスケード(`main.ts:360-373`)→ `handlePaintEditorKeydown`(`main.ts:401`)
- `registerEventBinder`(`actionRegistry.ts:31-33`)は現在登録者ゼロ。本機能が初の実利用
- クライアントに dragover/drop/paste リスナは皆無 → 現状ウィンドウへのファイルドロップは**ページ遷移でアプリ離脱**(window ガード必須)
- undo は canvas スナップショットのリング(上限 5)。`paintUndoStacks` は export され `generationController.ts` からも参照
- **生成はサーバ主導**: クライアントは `parentAssetId` を送り、サーバが `parentAsset.image_path` を `uploadImageToComfy` で ComfyUI へ(`rounds.ts:146-148`)
- **クライアント合成画像を生成リクエストに載せる前例**: `inpaint.maskDataUrl`(PNG dataUrl)→ サーバ `prepareInpaintRequest`(`rounds.ts:245`)が decode → `storeMaskImage(projectId, roundId, bytes)`(`storage.ts:68`、`masks/` 配下に `<roundId>_mask.png`)→ `maskPath` として request_json に記録(dataUrl は破棄)→ `uploadImageToComfy(maskPath)`。ControlNet の `poseImageDataUrl` も同型
- dataUrl 検証は `decodeImageDataUrl` / `decodeMaskDataUrl`(`uploadDataUrl.ts`、16MB 上限・MIME・マジックバイト)
- DB は node:sqlite(`db.ts`)。`ensureColumn` による軽量マイグレーション前例あり。プロジェクトごとのストレージディレクトリ(`storage.ts` の `ensureProjectStorage`)
- id 付き要素は domMorph が同一ノード維持。pose SVG に `vector-effect: non-scaling-stroke` 前例
- **既知バグ(フェーズ0対象)**: ペイントモード中の中ボタンパンは `finishImagePan`(`maskEditorController.ts:357-384`)が常に `InpaintDraft.panOffset` へ保存する一方、render は `PaintDraft.panOffset` を読む(`assetModal.ts:82-84`)ため pointerup 直後に snap-back。実コードで確認済み

## 設計

### コンセプト: 「エッジに添付」モデル

```
[ツリー]   元画像アセット ──(生成エッジ)──▶ 生成ラウンド
                 │                          │
                 │ 添付オブジェクト           │ 実際に送った合成画像
                 │ (配置つき・永続・再編集可)  │ (<roundId>_composite.png、記録用)
                 ▼                          ▼
[編集画面] 元画像+ペイント+添付を重ねて表示   request_json に compositePath
```

- 元画像アセットのファイル・メタデータは**一切変更しない**
- 添付オブジェクト(貼り付け画像+変形)は**アセットに紐づく編集状態**としてサーバへ永続化。開き直しで復元、選択してどかす(移動/削除)ことも可能
- 生成時にクライアントが見た目どおりに合成した PNG を送り、サーバはそれを img2img 入力として ComfyUI へ。合成 PNG はラウンドのストレージに残る(何を入力したかの記録=再現性)

### 表示スタック

`.mask-zoom-stage` 内、上から:

```
svg#pasteGizmoOverlay   … 選択枠+変形ハンドル(viewBox = natural size、選択中のみ)
canvas#pasteCanvas      … 添付オブジェクトの合成表示(opacity 1、pointer-events: none)
canvas#paintCanvas      … 既存ペイントレイヤー表示(opacity 0.58 のまま不変、入力面)
img#previewImage        … 元画像
```

オブジェクトは常に全不透明で表示され、ペイントストロークの上に重なる。「貼った画像の上にブラシで描きたい」場合のみ明示の「レイヤーへ焼き込み」操作(この場合はペイントレイヤーの一部になるため、img2img へ反映するには従来の `paint-save` か生成時合成に乗る)。

### (a) モードの位置づけ

第3モードは作らず**ペイント編集モード内の新ツール `"select"`**(`PaintToolKind` に追加)。

- **入口はモードに縛らない**: モーダル表示中ならドロップを常時受け付け、マスク編集中/非編集中は自動でペイント編集へ切替+`tool="select"`+新オブジェクトを選択状態に(トーストで遷移を明示)。InpaintDraft・マスクレイヤーは維持
- **ダブルクリック再選択**: brush/eraser/eyedropper 使用中でも、オブジェクト上のダブルクリックで `tool="select"` へ自動切替+選択。シングルクリックは従来どおり各ツールの動作
- モーダル非表示画面へのドロップは preventDefault のみ+案内トースト

### (b) データモデルと永続化

#### クライアント型(新規 `src/client/pasteTypes.ts`、DOM 非依存 — サーバ検証と共有できるよう shared 配置も実装時に検討)

```ts
export interface PasteTransform {
  x: number;        // オブジェクト中心の natural px
  y: number;
  rotation: number; // ラジアン
  scaleX: number;   // UI は当面 uniform のみ、将来の自由変形に備え分離
  scaleY: number;
}
export interface PastedObject {
  id: string;          // crypto.randomUUID()
  sourceId: string;    // paste-sources のキー(サーバ永続。複製で共有可)
  sourceWidth: number; // 取り込み後ビットマップ px(長辺 4096 キャップ)
  sourceHeight: number;
  transform: PasteTransform;
  // 配列内の位置が z順(先頭=最背面)
}
export const PASTE_MAX_SOURCE_DIMENSION = 4096;
export const PASTE_ROTATION_SNAP_DEG = 15;
```

- `PaintDraft` に `pasteObjects: PastedObject[]` と `selectedPasteObjectId: string | null` を追加。**draft はサーバ永続値のクライアント側キャッシュ**という位置づけになる(localStorage には引き続き入れない)
- ビットマップは `pasteBitmapCache: Map<sourceId, HTMLCanvasElement>`(module ローカル)。**ソースはサーバ配信(same-origin)なので taint なし**

#### サーバ永続化(新規・追加のみ)

- **DB**: 新テーブル(`initializeDb` に追加、既存テーブル不変):

```sql
CREATE TABLE IF NOT EXISTS asset_paste_attachments (
  asset_id TEXT PRIMARY KEY,
  objects_json TEXT NOT NULL,      -- PastedObject[](z順)
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
```

- **ソース画像ストレージ**: プロジェクトストレージ配下に `paste_sources/`(`ensureProjectStorage` へ 1 ディレクトリ追加)。`<sourceId>.png` で保存
- **API(新設)**:
  - `POST /api/projects/:projectId/paste-sources` — body `{ dataUrl }`。`decodeImageDataUrl`(16MB/MIME 検証)再利用 → 保存 → `{ sourceId, url, width, height }`
  - `GET /api/projects/:projectId/paste-sources/:sourceId` — ファイル配信(既存のアセット画像配信と同パターン)
  - `GET /api/assets/:assetId/paste-attachments` — `{ objects }`(無ければ空配列)
  - `PUT /api/assets/:assetId/paste-attachments` — `{ objects }` を検証(数値の有限性・scale>0・sourceId 実在)して upsert
- **保存タイミング(クライアント)**: オブジェクト操作の確定(pointerup・追加・削除・複製・重ね順・焼き込みによる除去)ごとに **debounce(~800ms)で PUT**。モーダル close 時は即時 flush。楽観更新(UI はクライアント状態が真実、PUT 失敗はトースト+リトライ)
- **復元**: アセットモーダルを開いたとき(または paint 編集 ON 時)に GET → draft へ反映 → sourceId ごとに `paste_sources` URL を fetch → bitmap キャッシュへ。ロード中はプレースホルダ矩形を表示
- ソースファイルの GC(どの添付からも参照されなくなったファイルの削除)は初期スコープ外(個人ツールの規模では実害なし。未決事項 #4)

#### undo — 時系列統合スタック(既存 `paintUndoStacks` の置換)

前版どおり `paintHistoryStacks: Map<assetId, PaintHistoryEntry[]>` へ置換(`layer` = canvas スナップショット / `objects` = メタデータ配列の軽量コピー)。

- push 契機: ストローク開始/クリア = `layer`、オブジェクトのドラッグ開始・追加・削除・複製・重ね順 = `objects`、焼き込み = 2 連 push
- Ctrl+Z は kind で分岐復元。**undo で戻した結果も debounce PUT で永続化される**(サーバ状態は常に「今見えている状態」に追随)
- 型は新規 `src/client/paintHistory.ts`(HTMLCanvasElement を含むため DOM 非依存規約の `paintTypes.ts` には置かない)。generic な pure helper `pushPaintHistoryEntry<T>`(layer 上限 5・総数上限 30、底から切り詰め)を DOM なしでテスト
- **回帰リスク対策**: フェーズ 1 でテスト固定(オブジェクトが無い限り既存 undo と完全等価)してから載せ替え

### (c) 入力経路(DnD / クリップボード / ファイル選択)

`registerEventBinder` 初利用として `pasteObjectController.ts` が配線:

1. **window ガード(常時)**: `dragover`/`drop` で `preventDefault()`。受け入れ可能時のみ `dropEffect="copy"`
2. **OS ファイル D&D**: MIME は `uploadSourceAsset` と同じ **png/jpeg/webp** whitelist+同一文言のエラートースト。複数ファイルは各々オブジェクト化。**ドロップ即 `paste-sources` へ POST**(永続化)しつつ、bitmap はローカル blob から即時デコードして表示(POST 完了を待たない。失敗時はオブジェクトを取り消してトースト)
3. **アプリ内サムネイル D&D**: `#app` への `dragstart` 委譲で `application/x-guruguru-asset-id` を setData、drop 側はこれを最優先・`text/uri-list` から assetId 抽出をフォールバック。**必ず assetId を解決して `/api/assets/:id/image`(フル解像度)を fetch** → paste-sources へコピー(元アセットが後で削除されても添付は生きる)。「前の生成結果をこの画像に合成」が D&D 一発
4. **Ctrl+V**: window `paste` リスナ(`isTextEntryTarget` は `clientUtils.ts` へ移設して共用)。配置は canvas 中央
5. **ファイル選択ボタン**: paintPanel に `data-action="paste-pick-file"`(`iconImage()` 再利用)
6. **taint 安全**: 取り込みは必ず File/Blob/same-origin fetch → `createImageBitmap` → offscreen canvas。リモート URL の `<img>` 直 drawImage 経路は作らない。File なし・cross-origin URL のみは拒否+トースト
7. **フィードバック**: dragenter/leave の `.paste-drop-active` ハイライト(classList 直接操作、文言出し分け)。decode/アップロード 150ms 超のみ「読み込み中…」。失敗は行動可能な文言でトースト

**初期配置**: drop 座標を `pointerToMaskCanvasPoint` で natural 化して中心に(モード切替直後の未サイズ時は pending 配置)。初期スケールは `fitInitialPasteTransform`(ベース画像の 60% に収まる縮小、拡大なし)。

### (d) 変形 UI(ギズモ)— 前版から変更なし(要点のみ)

- ギズモは `<svg id="pasteGizmoOverlay" viewBox="0 0 W H">`(id 付き=domMorph 保持、`vector-effect: non-scaling-stroke`)。ハンドルサイズは rect 比換算+`handlePaintWheelZoom` への `syncPasteGizmoScale()` 1 行フック
- 操作: 本体ドラッグ=移動(Shift=軸ロック)/ 4 隅=中心アンカー uniform スケール(Shift=XY 独立)/ 回転ハンドル(Shift=15° スナップ、dblclick=0°)/ 矢印=1px・Shift+矢印=10px / Delete=削除 / Esc=選択解除(カスケード: 削除プレビュー閉 → 選択解除 → モーダル閉)/ **任意ツールから dblclick=再選択**
- **ドラッグ中は `requestRender()` しない**: rAF バッチで `#pasteCanvas` dirtyRect 再描画+SVG 属性直更新、pointerup で draft 確定+`requestRender()`+debounce PUT。pointercancel は開始時 transform へ巻き戻し
- 回転は canvas/SVG 内のみ(CSS transform に入れない)。イベント配線は `handlePaintEditorPointerDown` 等の直前に各 1 行挿入、keydown は `handlePaintEditorKeydown` 先頭から内部呼び出し、Esc のみ `main.ts:360-373` カスケードへ 1 分岐
- パネル: select ツールボタン+選択中の「オブジェクト操作」行(削除/複製/前面へ/背面へ/焼き込み)+スケール%・回転角読み出し

### (e) 再レンダー(domMorph)を跨いだ状態保持 — 前版から変更なし(要点のみ)

真実 = `state.paintDrafts`(メタデータ)+ `pasteBitmapCache`(bitmap)+ サーバ(永続)。`#pasteCanvas` は morph でリセットされるため `main.ts:592` 直後に `syncAssetModalPasteObjects()` を 1 行追加して毎 render 復元。ギズモ SVG は id 保持+sync 上書き。`selectedPasteObjectId` の stale ガード。close 時は進行中ドラッグ破棄+PUT flush(オブジェクトは永続なので消えない)。

### (f) 生成との合流(保存操作の廃止)

**明示の保存は不要**。img2img 系生成(img2img / inpaint / controlnet+img2img)の実行時:

1. **クライアント**(`generateRound`, `generationController.ts:56`): 親アセットに添付オブジェクトがある、またはペイントレイヤーに内容がある場合、`composePaintResultCanvas` 拡張(第 5 引数 `pastedLayers`)で「元画像 → ペイントレイヤー → オブジェクト(z順)」を合成。**未保存のペイントストロークも含める(=見たままを送る。ユーザー確認済み 2026-07-06)**。ストロークは非永続のため、開き直し後も残したい場合は従来どおり `paint-save` を使う → `request.pasteComposite = { imageDataUrl }` を生成リクエストに追加。**POST 前に 16MB プリフライト**(超過時は送信せず「合成結果が 16MB を超えています…」トースト)
   - モーダルを開いていない状態からの生成(ギャラリーの img2img ボタン等)でも、添付が永続化されているため GET+fetch で合成可能(bitmap 未ロード時は合成前にロード)
2. **サーバ**(`rounds.ts`): `preparePasteCompositeRequest`(`prepareInpaintRequest` `rounds.ts:245` と同型)を追加 — dataUrl を decode(`decodeImageDataUrl` 系の検証再利用)→ `storeCompositeImage(projectId, roundId, bytes)`(`storage.ts` に `composites/` を追加、`<roundId>_composite.png`)→ request_json には `compositePath` のみ記録(dataUrl は破棄 — マスクと同じ)
3. **ComfyUI への入力差し替え**: `rounds.ts:146-148` の `uploaded = await uploadImageToComfy(...)` を「`request.pasteComposite?.compositePath` があればそれ、無ければ従来どおり `parentAsset.image_path`」に変更。**`parentAssetId` / `parent_round_id` は元画像のまま** → ツリーの親子・枝色・エッジは不変
4. **記録**: 合成 PNG がラウンドのストレージに残り、request_json の `compositePath` から辿れる(何を入力したかの再現性)。ラウンド削除時のファイル掃除はマスクと同じ扱いに揃える

- txt2img には合成を付けない(親を使わないため)
- スポイトはオブジェクト込みの合成から採色(WYSIWYG 化、意図的変更)
- **既存 `paint-save`(新規アセットとして保存)は残す**(ペイント結果を独立アセットにしたい従来ワークフロー用)。その合成にもオブジェクトを含める(見たまま)。保存後も添付は元アセットに残る

### (g) 実装フェーズ分割

ブランチ: `feature/image-paste-N-<slug>`(git worktree、main チェックアウト維持)。各フェーズで `npm run typecheck` / `npm test` / `$env:GURUGURU_TEST_DB='1'; npm run check` / `git diff --check`。UI 確認は 1680×920・非 5177 ポート+`GURUGURU_TEST_DB=1`。**サーバのテストは必ずテスト DB**(AGENTS.md)。変形操作の動作検証は claude-in-chrome。

- **フェーズ 0(事前バグ修正・要ユーザー確認・単独コミット)**: ペイントモード中パンの snap-back 修正(`maskEditorController.ts:326-384` に paintEditMode 分岐)
- **フェーズ 1: 型+pure helper+テスト**: `pasteTypes.ts` / `pasteTransform.ts`(変形幾何・ヒットテスト・fit・dirtyRect・スナップ・クランプ)+ test。`paintHistory.ts`(generic `pushPaintHistoryEntry`、既存 undo との等価性テスト)。`PaintDraft` 拡張+normalize+test。添付 JSON の検証 helper(サーバと共用できる形)
- **フェーズ 2: サーバ永続化**: `asset_paste_attachments` テーブル、`paste_sources/` ストレージ、paste-sources POST/GET・paste-attachments GET/PUT(検証込み)+ `http.test.ts` 系のテスト
- **フェーズ 3: 取り込みと表示+復元**: `pasteObjectController.ts`(window ガード、decode、4096 キャップ、POST 連携、pending 配置、トースト群)、`#pasteCanvas`+sync、select ツールボタン、`paste-pick-file`、ドロップハイライト、**モーダルオープン時の GET+bitmap ロード+復元**
- **フェーズ 4: 選択・変形ギズモ+永続化**: `views/pasteGizmo.ts`、pointer 分岐挿入、move/scale/rotate、**dblclick 再選択(任意ツールから)**、Delete/Esc/Shift/ナッジ、カーソル、%/角度読み出し、wheel フック、**debounce PUT**
- **フェーズ 5: 履歴統合+オブジェクト操作 UI**: `paintUndoStacks` → `paintHistoryStacks` 置換(ストローク undo 挙動不変をテスト+手動確認)、オブジェクト操作 undo(削除の取り消し含む)、パネル操作行(削除/複製/前面/背面/焼き込み)、`shortcuts.ts`
- **フェーズ 6: 生成合流**: クライアント合成+`pasteComposite` リクエストフィールド+16MB プリフライト、サーバ `preparePasteCompositeRequest`+`storeCompositeImage`+入力差し替え+テスト(`workflow.test.ts` 系)、モーダル非表示からの生成経路、スポイト統一、Ctrl+V・アプリ内サムネイル D&D、`操作メモ.md`・本書更新
- **フェーズ 7(任意)**: ツリー/エッジへの添付ありバッジ表示、ソースファイル GC、複数選択、外部 URL のサーバプロキシ取り込み

### 触るファイル一覧

**新規(クライアント)**: `pasteTypes.ts` / `pasteTransform.ts`(+test) / `paintHistory.ts`(+test) / `pasteObjectController.ts` / `views/pasteGizmo.ts`

**新規(サーバ)**: `src/server/pasteAttachments.ts`(API ハンドラ+検証、+test)

**変更(クライアント)**: `paintTypes.ts`・`paintDraft.ts`(+test) / `paintEditorController.ts`(履歴統合・sync・wheel フック) / `paintCanvas.ts`(合成第 5 引数、+test) / `views/assetModal.ts`(pasteCanvas+ギズモ) / `views/paintPanel.ts` / `main.ts`(分岐挿入・sync 各 1 行、新規関数なし) / `generationController.ts`(生成時合成・プリフライト) / `assetDetailController.ts`(open 時復元・close 時 flush) / `draftStore.ts`(切替時キャッシュ掃除。import 方向は実装時確認) / `maskEditorController.ts`(フェーズ 0 のみ) / `clientUtils.ts` / `api.ts`(必要なら) / `shortcuts.ts` / `styles/editors.css` 等

**変更(サーバ)**: `db.ts`(テーブル追加) / `storage.ts`(`paste_sources/`・`composites/`・store 関数) / `http.ts`(ルート追加) / `rounds.ts`(`preparePasteCompositeRequest`+入力差し替え) / `generationRequest.ts`(`pasteComposite` の正規化) / `uploadDataUrl.ts`(必要なら検証関数追加) / 各 test

### (h) 変えないこと(不変条件)

1. **元画像アセット**: ファイル・メタデータ・ツリー上の位置・親子関係(`parent_round_id` は従来どおり親アセットの round)を一切変更しない
2. **既存 API の既存フィールド**: source-assets・rounds・assets 各エンドポイントの既存の意味・検証は不変。**追加のみ**(新テーブル・新ルート・生成リクエストの省略可能な新フィールド)
3. **マスク編集の全挙動**(フェーズ 0 は paintEditMode 分岐の追加のみ)
4. **ブラシ/消しゴム/スポイトのストローク経路**(rAF+dirtyRect)。※スポイトの採色対象のみオブジェクト込み合成に変わる(意図的変更)
5. **ストローク undo の体感挙動**(スナップショット方式・layer 上限 5。統合履歴への置換はオブジェクト不在時に完全等価であることをテストで保証)
6. **wheel=ビューズーム、中ボタン=パン**、ズーム範囲 0.25–4
7. **`.mask-zoom-stage` の CSS transform は translate+scale のみ**(回転を入れない)
8. `.mask-canvas` の opacity 0.58(`#paintCanvas` 側)・canvas backing=natural px・devicePixelRatio 非使用
9. `paint-save` の API 契約・従来ワークフロー(残置)
10. 既存 pointer/keydown チェーンの相対順序。Esc の最終的な意味。`registerActions` の重複名なし

## 実装時の検証ポイント(残リスク)

- **`paintUndoStacks` 置換の回帰**(最重要): フェーズ 1 のテスト固定+フェーズ 5 の手動確認(ストロークのみ/オブジェクトのみ/交互)
- **debounce PUT と生成の競合**: 生成時の合成は常に**クライアントの現在状態**から行う(サーバの添付 JSON を読み直さない)ため、PUT 未達でも送る画像は見たままで一致する — この不変条件をコードコメントで明文化
- モーダル非表示からの img2img(ギャラリーボタン): bitmap 未ロード時の合成待ち(async 化)の UX
- 16MB: 添付ソース各 16MB 制限(POST 時)+合成結果 16MB プリフライト(生成時)の 2 段。4K 元画像+写真素材の組合せで実測
- 添付ソースのアップロード失敗・欠損(sourceId 解決失敗)時の縮退挙動(プレースホルダ+スキップ+トースト)
- dblclick 再選択とストローク開始(pointerdown)の弁別 — brush 中の dblclick は「オブジェクト上でのみ」`event.detail === 2` を pointerdown 段階で先取りする方式をフェーズ 4 で検証
- ラウンド削除時の `<roundId>_composite.png` 掃除(マスクファイルの既存扱いに揃える)
- draftStore → pasteObjectController の import 方向(循環時は callback 登録へ)

## 未決事項(実装前にユーザー確認)

1. フェーズ 0 のパン snap-back 修正を先行してよいか(既存挙動の変更)
2. 対応形式は png/jpeg/webp(既存アップロードと同一 whitelist)で良いか
3. 添付ソースファイルの GC(参照ゼロの掃除)は初期スコープ外で良いか
4. ツリー上に「添付あり」の目印(エッジ/ノードのバッジ)を出すか(フェーズ 7 任意)

## 確認済みの決定事項

- 貼り付けは保存まで非破壊・ダブルクリックで再選択可能(→ B 案採用、2026-07-06)
- 保存操作は不要。生成時に合成し、親ノードは変更せず「エッジに添付」する。配置はサーバ永続化し開き直しで復元(2026-07-06)
- 生成時合成に未保存のペイントストロークも**含める**(見たままを送る)(2026-07-06)

## 変更履歴

- 2026-07-06: 起票。3 案の独立設計と 2 レンズ審査を経た統合設計(A 骨格ベース)の初版。
- 2026-07-06: ダブルクリック再選択の要望を受け B 案(非破壊オブジェクトレイヤー)ベースへ改訂。
- 2026-07-06: **保存操作を廃止し「エッジに添付」モデルへ改訂**。添付オブジェクトをアセット単位でサーバ永続化(開き直しで復元)、生成時にクライアント合成を `pasteComposite` として送りサーバがファイル化して ComfyUI へ(maskDataUrl と同型)。親ノード・ツリーは不変。
- 2026-07-06: ユーザー確認により「生成時合成に未保存のペイントストロークも含める」を決定事項へ移動。実装は着手待ち。
