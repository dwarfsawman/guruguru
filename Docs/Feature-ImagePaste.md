# 画像貼り付け(Paste & Transform)機能

- ステータス: 設計(未着手)
- 最終更新: 2026-07-06

## 概要

アセット詳細モーダルのペイント/マスク編集エリアに画像を**ドラッグ&ドロップ**(または Ctrl+V / ファイル選択 / アプリ内サムネイルの D&D)で貼り付け、**移動・回転・拡大縮小**できる。貼り付けた画像は**保存まで非破壊のオブジェクト**として保持され、**ダブルクリックでいつでも再選択・再変形・削除・重ね順変更が可能**。保存時に「元画像+ペイントレイヤー+オブジェクト群」を合成して既存の `paint-save`(`savePaintResultAsSourceAsset`、`generationController.ts:636-705`)から source-assets API へ送り、img2img の素材になる。**サーバ/API は一切変更しない**。

## 設計の経緯(3案比較とユーザー決定)

独立に設計した 3 案を 2 レンズで審査した:

| 案 | 骨格 | 適合性審査 | UX審査 |
|---|---|---|---|
| A: 最小統合 | 単一浮遊オブジェクト、確定で即焼き込み | 勝者(risk 最小) | 確定後の再調整不可・配置プレビューが opacity 0.58 に沈む |
| B: オブジェクトレイヤー | 複数オブジェクトを保存まで非破壊保持、undo を時系列統合 | 実装リスク最大 | **勝者**(複数素材の反復調整・誤操作からの回復で圧勝) |
| C: UX最優先 | 単一オブジェクト+SVG オーバーレイ、操作の磨き込み特化 | 表示層は最良 | 瞬間の操作感は最良(表層は移植可能) |

当初は A 骨格を推奨としたが、**「貼り付け後にダブルクリックで素材を再選択したい」というユーザー要望により B案(フル)を採用**(2026-07-06 決定)。確定式では再選択が構造的に成立しないため。C 案の磨き込み層(発見性・フィードバック)と A 案の運用(フェーズ0分離)を B へ移植する。適合性審査が挙げた B の弱点 3 点(undo 置換の回帰リスク / 型の置き場所 / import 方向)には本書で対策を明記した。

## 現状の土台(調査で確認済みの事実)

- ペイント編集(`state.paintEditMode`)は natural-size の `#paintCanvas` を `#previewImage` に重ね、真実は module ローカルの `paintLayerCache`(`paintEditorController.ts:19`)。再レンダー(domMorph は canvas の width/height 属性を剥がして内容を消す)後は render 末尾の `syncAssetModalPaintCanvas()`(`main.ts:592`)が毎回復元する
- 座標変換は `pointerToMaskCanvasPoint`(`maskCanvas.ts`)が fit×zoom×pan を `getBoundingClientRect` 比で自動吸収。**成立条件は「`.mask-zoom-stage` の CSS transform が translate+scale のみ」**(回転を CSS に入れてはならない)
- pointer 分岐チェーン(`main.ts:420-438`): pose → mask → workflowDiagram → ボタンフィルタ → paint → maskStroke。keydown は Escape カスケード(`main.ts:360-373`)→ `handlePaintEditorKeydown`(`main.ts:401`)の順
- `registerEventBinder`(`actionRegistry.ts:31-33`)は**現在登録者ゼロ**。本機能が初の実利用となる
- クライアントに dragover/drop/paste リスナは皆無 → 現状ウィンドウへのファイルドロップは**ページ遷移でアプリ離脱**する(window ガード必須)
- undo は canvas スナップショットのリング(上限 5、`PAINT_UNDO_STACK_LIMIT`)。`paintUndoStacks` は export され `generationController.ts` からも参照される
- `paintDrafts` は localStorage 非永続(`draftStore.ts`)。プロジェクト切替でクリア
- id 付き要素は domMorph が同一ノードを維持する(`domMorph.ts:23-48`)。pose の SVG ハンドルに `vector-effect: non-scaling-stroke` の前例あり
- **既知バグ(フェーズ0対象)**: ペイントモード中の中ボタンパンは `finishImagePan`(`maskEditorController.ts:357-384`)が常に `InpaintDraft.panOffset` へ保存する一方、render は `PaintDraft.panOffset` を読む(`assetModal.ts:82-84`)ため、pointerup 直後にパンが元へ戻る(snap-back)。実コードで確認済み

## 設計

### 表示スタック(コンセプト)

`.mask-zoom-stage` 内、上から:

```
svg#pasteGizmoOverlay   … 選択枠+変形ハンドル(viewBox = natural size、選択中のみ)
canvas#pasteCanvas      … 貼り付けオブジェクトの合成表示(opacity 1、pointer-events: none)
canvas#paintCanvas      … 既存ペイントレイヤー表示(opacity 0.58 のまま不変、入力面)
img#previewImage        … 元画像
```

オブジェクトは常に全不透明で表示され(0.58 に沈まない)、ペイントストロークの**上**に重なる。「貼った画像の上にブラシで描きたい」場合は明示の「レイヤーへ焼き込み」操作を使う。

### (a) モードの位置づけ

第3モードは作らず**ペイント編集モード内の新ツール `"select"`** とする(`PaintToolKind` に追加)。ツールパネルにボタンを 1 つ足すだけで、既存のモード相互排他・レイアウト・close 後始末をそのまま使える。

- **入口はモードに縛らない**: モーダル表示中ならドロップを常時受け付け、マスク編集中/非編集中は自動でペイント編集へ切替+`tool="select"`+新オブジェクトを選択状態に(トースト「ペイント編集に切り替えて貼り付けました」)。InpaintDraft・マスクレイヤーは維持される
- **ダブルクリック再選択(ユーザー要望)**: brush/eraser/eyedropper 使用中でも、`#paintCanvas` 上の**ダブルクリックがオブジェクトにヒットしたら `tool="select"` へ自動切替+そのオブジェクトを選択**する。シングルクリックは従来どおり各ツールの動作(誤爆しない)。select ツール中はシングルクリックで選択/選択解除
- brush/eraser/eyedropper のストローク挙動は一切変えない(select 中のみ pointerdown がヒットテストになる)
- モーダル非表示画面へのドロップは preventDefault のみ+案内トースト

### (b) データモデルと確定・undo

```ts
// 新規 src/client/pasteTypes.ts(DOM 非依存。maskTypes.ts と同じ流儀)
export interface PasteTransform {
  x: number;        // オブジェクト中心の natural px
  y: number;
  rotation: number; // ラジアン
  scaleX: number;   // UI は当面 uniform のみだが将来の自由変形に備え分離
  scaleY: number;
}
export interface PastedObject {
  id: string;        // crypto.randomUUID()
  bitmapId: string;  // pasteBitmapCache のキー(複製で共有可)
  sourceWidth: number;   // 取り込み後ビットマップ px(長辺 4096 へダウンスケールキャップ)
  sourceHeight: number;
  transform: PasteTransform;
  // 配列内の位置が z順(先頭=最背面)。zIndex フィールドは持たない
}
export const PASTE_MAX_SOURCE_DIMENSION = 4096;
export const PASTE_ROTATION_SNAP_DEG = 15;
```

- `PaintDraft` に `pasteObjects: PastedObject[]`(配列順=z順)と `selectedPasteObjectId: string | null` を追加(`defaultPaintDraft`/`normalizePaintDraft` 対応)。localStorage 非永続方針はそのまま
- ビットマップ本体は `pasteBitmapCache: Map<bitmapId, HTMLCanvasElement>`(新規 `pasteObjectController.ts` の module スコープ、`paintLayerCache` と同型)。**モーダルを閉じて再度開いても(同プロジェクト内なら)貼り付けは復元される** — paintLayer と同じ寿命で一貫
- **常時非破壊**。ラスタライズは次の 2 点のみ:
  - **保存時(自動)**: 「元画像 → paintLayer → pasteObjects(z順)」の 3 層合成を PNG 化。保存成功後にオブジェクト・キャッシュを破棄
  - **「レイヤーへ焼き込み」(明示操作)**: 選択オブジェクトを paintLayer へ変形付き `drawImage`(`imageSmoothingQuality="high"`)→ オブジェクト削除。以降その上にブラシで加筆できる

#### undo — 時系列統合スタック(既存 `paintUndoStacks` の置換)

`paintUndoStacks: Map<assetId, HTMLCanvasElement[]>` を `paintHistoryStacks: Map<assetId, PaintHistoryEntry[]>` へ置き換える:

```ts
// 置き場所は新規 src/client/paintHistory.ts(HTMLCanvasElement を含むため
// 「DOM 非依存」規約の paintTypes.ts には置かない — 審査指摘への対策)
export type PaintHistoryEntry<TSnapshot = HTMLCanvasElement> =
  | { kind: "layer"; snapshot: TSnapshot }              // ストローク/クリア/焼き込み前
  | { kind: "objects"; objects: PastedObject[] };        // オブジェクト操作前(メタデータのみで軽量)
export const PAINT_UNDO_LAYER_LIMIT = 5;    // 既存 PAINT_UNDO_STACK_LIMIT を継承(メモリ根拠は Feature-PaintTool.md)
export const PAINT_UNDO_TOTAL_LIMIT = 30;   // objects エントリ込みの総数上限
```

- push 契機: ストローク開始/クリア = `layer`、**オブジェクトのドラッグ開始・追加・削除・複製・重ね順変更** = `objects`、焼き込み = `layer`+`objects` の 2 連 push
- Ctrl+Z は最新エントリを kind で分岐復元: `layer` → 既存 `restorePaintLayerFromSnapshot`、`objects` → `draft.pasteObjects`/選択を差し替えて `requestRender()`。**ストロークとオブジェクト操作が交互でも時系列どおり戻り、削除の取り消しも効く**
- 上限管理は **generic な pure helper `pushPaintHistoryEntry<T>`**(snapshot 型をオパークに扱い DOM なしでテスト可能 — 審査指摘への対策): layer エントリ数 5 超で底から shift、総数 30 でも底から切り詰め
- **回帰リスク対策(審査指摘)**: フェーズ 1 で pure helper をテストで固めてから載せ替える。`layer` エントリのみの経路は既存 undo と完全等価(スナップショット方式・上限 5 不変)であることをテストで保証
- 削除 undo でビットマップ参照が復活するため、**`pasteBitmapCache` の破棄は履歴スタックも破棄されるタイミング(保存成功/プロジェクト切替)に限定**し、オブジェクト削除時には消さない

### (c) 入力経路(DnD / クリップボード / ファイル選択)

`registerEventBinder` 初利用として `pasteObjectController.ts` の `bindPasteObjectEvents(app)` が配線:

1. **window ガード(常時)**: `dragover`/`drop` で `preventDefault()`(アプリ離脱防止)。受け入れ可能時のみ `dropEffect="copy"`
2. **OS ファイル D&D**: MIME は `uploadSourceAsset`(`projectController.ts:167-171`)と同じ **png/jpeg/webp** whitelist+同一文言のエラートースト。**複数ファイル同時ドロップは各々オブジェクト化**(非破壊モデルなので全部保持できる)
3. **アプリ内サムネイル D&D**: `#app` への `dragstart` 委譲で `dataTransfer.setData("application/x-guruguru-asset-id", assetId)` を仕込み、drop 側はこれを最優先、`text/uri-list` から assetId 抽出をフォールバックとする。**必ず assetId を解決して `/api/assets/:id/image`(フル解像度・same-origin)を fetch する** — uri-list の URL 直 fetch はサムネイル縮小版を貼ってしまうため禁止。「前の生成結果をこの画像に合成」が D&D 一発になる本機能の隠れた主役
4. **Ctrl+V**: window `paste` リスナ。`state.activeAssetId` あり かつ `isTextEntryTarget` でないとき(`isTextEntryTarget` は `main.ts:500-508` から `clientUtils.ts` へ移設して共用)。配置は canvas 中央
5. **ファイル選択ボタン**: paintPanel に `data-action="paste-pick-file"`(動的 `input type=file`)。アイコンは `iconImage()` 再利用(galleryView で使用中の既存アイコン)
6. **taint 安全の統一経路**: すべて File/Blob → `createImageBitmap`(fallback: blob URL + Image)→ offscreen canvas へ 1 回だけ転写してキャッシュ。**リモート URL の `<img>` を直接 drawImage する経路は作らない**(レイヤー taint で `toDataURL`/スポイトが全滅するため)。File なし・cross-origin URL のみのドロップは拒否+トースト「外部サイトの画像は一度保存してからドロップしてください」
7. **フィードバック**: dragenter/leave で `.preview-media` に `.paste-drop-active` ハイライト(classList 直接操作、render 不要。マスク編集中は「ドロップでペイント編集に切り替えて貼り付け」と文言出し分け)。decode 150ms 超のみ「読み込み中…」トースト。非対応形式・巨大画像は行動可能な文言でエラートースト

**初期配置**: drop 座標を `pointerToMaskCanvasPoint` で natural 化しオブジェクト中心に(canvas 外はクランプ、Ctrl+V/ボタンは中央)。モード自動切替直後で `#paintCanvas` が未サイズの場合(画像 load 待ち)は **pending 配置**として保持し、切替後の sync で配置。初期スケールは pure helper `fitInitialPasteTransform`: ベース画像の 60% に収まる縮小率(拡大しない、uniform)。

### (d) 変形 UI(ギズモ)

**SVG オーバーレイ(ギズモ)+ `#pasteCanvas`(オブジェクト表示)の 2 層**。

- ギズモは `renderPreviewMedia`(`assetModal.ts:136-145`)に宣言的に追加する `<svg id="pasteGizmoOverlay" viewBox="0 0 W H">`(websam overlay と同型)。**id 付きなので domMorph で保持**。選択オブジェクトの外接矩形 path(`vector-effect: non-scaling-stroke` — zoom で線幅不変)+ 4 隅スケールハンドル + 上辺から突き出た回転ハンドル
- ハンドル図形サイズは毎 render 後の sync で `目標画面px × canvas.width / rect.width` 換算。wheel zoom tick は render を経ないため `handlePaintWheelZoom`(`paintEditorController.ts:30-61`)の setProperty 直後に `syncPasteGizmoScale()` を 1 行フック
- SVG root は `pointer-events:none`、ハンドルのみ `pointer-events:all` + `data-paste-handle`。オブジェクト本体のヒットは `#paintCanvas`(入力面)への pointerdown を逆変換 M⁻¹ ヒットテスト(pure 関数、配列末尾=最前面から探索)で行う
- **操作体系**:

| 操作 | ジェスチャ | 修飾キー等 |
|---|---|---|
| 選択 | select ツールでオブジェクトをクリック / **任意ツールでダブルクリック**(自動で select へ) | 空き領域クリック=選択解除 |
| 移動 | 本体ドラッグ(select 中) | Shift = 水平/垂直軸ロック |
| 拡大縮小 | 4 隅ハンドル。中心アンカーの uniform スケール(縮小可、下限 0.02) | Shift = XY 独立(自由アスペクト) |
| 回転 | 回転ハンドル(`atan2` 差分) | Shift = 15° スナップ。ダブルクリックで 0° |
| 微調整 | 矢印キー 1px / Shift+矢印 10px(選択中) | |
| 削除 | Delete / Backspace(undo 可) | |
| 選択解除 | Esc(選択がある場合のみ消費。無ければ従来どおりモーダルクローズへ) | |
| ズーム/パン | 既存のまま(wheel=ビューズーム、中ボタン=パン。オブジェクト操作に奪わない) | |

- **ドラッグ中は `requestRender()` しない**(pose の流儀): rAF 1 本のバッチで ①`#pasteCanvas` を dirtyRect(旧 bbox ∪ 新 bbox + margin、`clampDirtyRectToCanvas` 再利用)再描画 ②ギズモ SVG の属性直接更新。**pointerup で draft へ確定 + `requestRender()`**。pointercancel は開始時 transform へ巻き戻し。pointer capture は try/catch、pointerId 照合、クリック/ドラッグ弁別は閾値 3px(pose 前例)
- 回転は **canvas 2D / SVG 属性内のみ**。CSS transform には一切入れない(座標変換の成立条件)
- カーソル: 本体=move、スケールハンドル=`nwse/nesw-resize`、回転=`grab/grabbing`
- パネル(paintPanel): select ツールボタン+選択中のみ「オブジェクト操作」行(**削除/複製/前面へ/背面へ/レイヤーへ焼き込み**、`registerActions` で `paste-object-delete` 等の新名)+スケール%・回転角の読み出し(ジェスチャ中は `data-value-target` 方式で直接更新)

**イベント配線**: pointerdown/move/up/cancel は `handlePaintEditorPointerDown` 等の**直前**に `handlePastePointerDown` 等を各 1 行挿入(`main.ts:434` 前後。ボタンフィルタ通過後なので button 0 のみ。担当: ①`[data-paste-handle]` closest ②select 中 or ダブルクリックのヒットテスト/選択解除)。keydown(Delete/矢印)は `handlePaintEditorKeydown` の先頭から内部呼び出し(main.ts 無変更)。**Esc のみ特別扱い**: `main.ts:360-373` の Escape カスケードに `deletePreviewRoundId` 分岐の直後で `else if (deselectPasteObjectIfAny())` を挿入(①削除プレビュー閉 → ②選択解除 → ③モーダル閉、の 3 段)。

### (e) 再レンダー(domMorph)を跨いだ状態保持

| 資産 | 戦略 |
|---|---|
| オブジェクトメタデータ・選択状態 | `state.paintDrafts[assetId]`(render で消えない) |
| ビットマップ | `pasteBitmapCache`(morph の外) |
| `#pasteCanvas` | width/height 属性を持たないため morph のたびにリセットされる → `main.ts:592` の `syncAssetModalPaintCanvas()` 直後に `syncAssetModalPasteObjects()` を 1 行追加し、`#previewImage` の natural サイズから canvas 設定 → 全オブジェクトを z順に再描画 |
| ギズモ SVG | id で morph 保持。位置・サイズは draft から毎 render 計算+sync が上書き(選択なしなら非表示) |
| 整合ガード | sync 時に `selectedPasteObjectId` が `pasteObjects` に存在しなければ null へ(stale 対策) |

後始末: `closePaintEditorSession`/`closeAssetDetail` に「進行中 paste ドラッグ破棄(rAF キャンセル込み)」を追加。**オブジェクト自体は draft に残る**(モーダル再オープンで復元)。プロジェクト切替時(`draftStore.ts` の `resetProjectDrafts` 系)に `clearPasteBitmapCache()`+履歴破棄 — **draftStore → pasteObjectController の import 方向が規約上問題ないか実装時に確認し、循環になる場合は appState 経由の callback 登録へ**(審査指摘への対策として方針を先に決めておく)。

### (f) 保存との合流・16MB 制限

- `composePaintResultCanvas`(`paintCanvas.ts:51-60`)に**省略可能な第 5 引数**を追加: `pastedLayers?: Array<{ bitmap: CanvasImageSource; transform: PasteTransform; sourceWidth; sourceHeight }>`。z順に `translate·rotate·scale` 付き `drawImage`(`imageSmoothingQuality="high"`)。既定値省略で既存呼び出し不変
- `savePaintResultAsSourceAsset` の変更は 3 点のみ: ①合成呼び出しにオブジェクト配列を渡す(bitmapId 解決失敗はスキップ+警告トースト) ②**16MB プリフライト**: POST 前に `dataUrl.length` をサーバ側ガード(`uploadDataUrl.ts` の 16MB × base64 係数 1.4)相当のクライアント定数と比較し、超過時は送信せず「合成結果が 16MB を超えています。画像サイズを縮小してください」を即時トースト(既存 paint-save にも効く純改善) ③キャッシュ破棄(`generationController.ts:698-701`)に bitmapId 群と `paintHistoryStacks` を追加
- **スポイトも同じ合成関数を使い、オブジェクト込みの見た目から採色される**(WYSIWYG 化。意図的な小変更として明記)
- POST body・ファイル名・templateId 解決・refreshProject・サーバ検証はすべて既存のまま

### (g) 実装フェーズ分割

ブランチ: `feature/image-paste-N-<slug>`(git worktree、main チェックアウト維持)。各フェーズで `npm run typecheck` / `npm test` / `$env:GURUGURU_TEST_DB='1'; npm run check` / `git diff --check`。UI 確認は 1680×920 viewport・非 5177 ポート+`GURUGURU_TEST_DB=1`。変形操作の動作検証は claude-in-chrome(第二次リファクタリングで確立した手法)。

- **フェーズ 0(事前バグ修正・要ユーザー確認・単独コミット)**: ペイントモード中パンの snap-back 修正。`beginImagePan`/`finishImagePan`(`maskEditorController.ts:326-384`)に `state.paintEditMode` 時は `PaintDraft.panOffset` を読み書きする分岐を追加。貼り付け配置はパンを多用するため先に潰す
- **フェーズ 1: 型+pure helper+テスト**: `pasteTypes.ts` / `pasteTransform.ts`(変形 4 頂点・変形後 bbox・逆変換ヒットテスト・中心アンカースケール式・回転スナップ・クランプ・`fitInitialPasteTransform`・ナッジ)+ `pasteTransform.test.ts`。`paintHistory.ts` の `PaintHistoryEntry` + generic `pushPaintHistoryEntry`(**既存 undo と layer-only 経路で等価であることをテストで固定**)。`PaintDraft` 拡張+normalize+`paintDraft.test.ts` 追記
- **フェーズ 2: 取り込みと表示**: `pasteObjectController.ts`(window ガード、File decode、4096 キャップ、モード自動切替+`tool="select"`、pending 配置、失敗トースト群)、`#pasteCanvas` テンプレート追加+`syncAssetModalPasteObjects()`、select ツールボタン、`paste-pick-file` ボタン、ドロップハイライト。**この時点で「ドロップ → 全不透明で表示 → 保存に含まれない(まだ)」まで**
- **フェーズ 3: 選択・変形ギズモ**: `views/pasteGizmo.ts`、pointer 分岐チェーン挿入(各 1 行)、move/scale/rotate ドラッグ(rAF+dirtyRect+SVG 直更新)、**ダブルクリック再選択(任意ツールから)**、クリック選択/解除、Delete、Esc カスケード、Shift 修飾、矢印ナッジ、カーソル、%/角度読み出し、wheel tick フック
- **フェーズ 4: 履歴統合+オブジェクト操作 UI**: `paintUndoStacks` → `paintHistoryStacks` 置換(**ストローク undo 挙動不変をテスト+手動で確認**)、オブジェクト操作の undo(削除の取り消し含む)、パネルのオブジェクト操作行(削除/複製/前面へ/背面へ/焼き込み)、`shortcuts.ts` 追記
- **フェーズ 5: 保存合流+後始末**: `composePaintResultCanvas` 拡張(+テスト)、保存でのオブジェクト込み合成、16MB プリフライト、スポイト合成統一、保存/プロジェクト切替/close の破棄経路(import 方向の確認込み)、Ctrl+V、アプリ内サムネイル dragstart+フル解像度 fetch、150ms 遅延ローディングトースト、`操作メモ.md`・本書更新
- **フェーズ 6(任意・第 2 段)**: 複数選択、アセットドラッグ時のドラッグイメージ改善、外部 URL のサーバプロキシ取り込み

### 触るファイル一覧

**新規**
| ファイル | 内容 |
|---|---|
| `src/client/pasteTypes.ts` | 型・定数(DOM 非依存) |
| `src/client/pasteTransform.ts`(+`.test.ts`) | 変形数学・ヒット判定・fit・dirtyRect の pure helper |
| `src/client/paintHistory.ts`(+`.test.ts`) | `PaintHistoryEntry` + generic `pushPaintHistoryEntry`(DOM 型を含むため paintTypes とは分離) |
| `src/client/pasteObjectController.ts` | bitmap キャッシュ、DnD/paste 配線(registerEventBinder 初利用)、ジェスチャ、registerActions |
| `src/client/views/pasteGizmo.ts` | ギズモ SVG render helper |

**変更**
| ファイル | 変更概要 |
|---|---|
| `paintTypes.ts` / `paintDraft.ts`(+test) | `PaintToolKind` に `"select"`、`pasteObjects`/`selectedPasteObjectId` 追加・normalize |
| `paintEditorController.ts` | 履歴統合(`paintHistoryStacks`)、sync 隣接、close 後始末、wheel フック 1 行 |
| `paintCanvas.ts`(+test) | `composePaintResultCanvas` の第 5 引数拡張 |
| `views/assetModal.ts` | `#pasteCanvas`+ギズモ SVG テンプレート |
| `views/paintPanel.ts` | select ツール+オブジェクト操作行+貼り付けボタン |
| `main.ts` | pointer 分岐 4 行・Esc カスケード 1 分岐・sync 1 行・import(新規関数は追加しない) |
| `generationController.ts` | 合成引数・16MB プリフライト・破棄参照名 |
| `assetDetailController.ts` | close 時のドラッグ破棄 |
| `draftStore.ts` | プロジェクト切替時のキャッシュ掃除(import 方向は実装時確認) |
| `maskEditorController.ts` | フェーズ 0 のパン書き先分岐のみ |
| `clientUtils.ts` | `isTextEntryTarget` 移設 |
| `shortcuts.ts` / `styles/editors.css`・`editor-panels.css` | ヘルプ追記 / `.paste-*` 一式(non-scaling-stroke、ハイライト) |

### (h) 変えないこと(不変条件)

1. **マスク編集の全挙動**(ツール・WebSAM・ポーズ・InpaintDraft の意味・3 カラムレイアウト・リサイザ。フェーズ 0 は paintEditMode 分岐の追加のみでマスクモードのパン経路は不変)
2. **ブラシ/消しゴム/スポイトのストローク経路**(rAF+dirtyRect パイプライン、ブラシサイズ 1–256、Alt 一時スポイト)。※スポイトの採色**対象**のみオブジェクト込み合成に変わる(意図的変更、(f) 参照)
3. **ストローク undo の体感挙動**(スナップショット方式・layer 上限 5)。内部実装は統合履歴に置換されるが、オブジェクトが無い限り完全等価であることをテストで保証
4. **wheel=ビューズーム、中ボタン=パン**の意味とズーム範囲 0.25–4
5. **`.mask-zoom-stage` の CSS transform は translate+scale のみ**(回転を入れない — 座標変換の成立条件)
6. `.mask-canvas` の opacity 0.58(`#paintCanvas` 側)・canvas backing=natural px・devicePixelRatio 非使用
7. **保存 API 契約**(body 形式・PNG 固定・`decodeImageDataUrl` の検証)とサーバコード全体
8. paintDrafts の localStorage 非永続方針(pasteObjects も同様に非永続)
9. 既存 pointer/keydown チェーンの相対順序(挿入のみ、並べ替えなし)。Esc の最終的な意味(モーダルを閉じる)。`registerActions` の重複名なし

## 実装時の検証ポイント(残リスク)

- **`paintUndoStacks` 置換の回帰**(最重要): フェーズ 1 のテスト固定+フェーズ 4 での手動確認(ストロークのみ・オブジェクトのみ・交互、の 3 系列)
- `#pasteCanvas`(opacity 1)とペイントレイヤー(0.58)の重なりの見え方、焼き込み時の表示変化(0.58 へ落ちる)が違和感ないか
- ダブルクリック再選択と select ツールのシングルクリック、ストローク開始(pointerdown)の弁別 — dblclick は pointerdown 2 回の後に発火するため、1 回目の pointerdown でストロークが始まらないよう **brush 中の dblclick 判定は「オブジェクト上でのみ」`event.detail === 2` を pointerdown 段階で先取りする**方式をフェーズ 3 で検証
- モード自動切替を伴うドロップでの pending 配置タイミング
- draftStore → pasteObjectController の import 方向(循環になる場合は callback 登録へ)
- ジェスチャ中 dirtyRect 再描画が 4K 画像でも重くないこと
- 貼り付け枚数が多い時のメモリ(bitmap 共有キャッシュ+4096 キャップで抑制。目安の上限枚数はフェーズ 2 で実測して決定)

## 未決事項(実装前にユーザー確認)

1. フェーズ 0 のパン snap-back 修正を先行してよいか(既存挙動の変更)
2. 対応形式は png/jpeg/webp(既存アップロードと同一 whitelist)で良いか。GIF(先頭フレーム)等へ広げるか
3. 「レイヤーへ焼き込み」した後の再選択は不可(焼き込みは Ctrl+Z でのみ戻せる)で良いか — 常時再選択したい場合は焼き込みを使わずオブジェクトのまま保存すれば良い、という整理
4. モーダルを閉じてもオブジェクトを保持(採用)で良いか、閉じる時に破棄すべきか

## 変更履歴

- 2026-07-06: 起票。3 案の独立設計と 2 レンズ審査を経た統合設計(A 骨格ベース)の初版。
- 2026-07-06: **ダブルクリックでの素材再選択の要望を受け、B 案(非破壊オブジェクトレイヤー・フル)ベースへ全面改訂**。任意ツールからのダブルクリック再選択を仕様化。審査指摘 3 点(undo 置換リスク/型の置き場所/import 方向)への対策を明記。
