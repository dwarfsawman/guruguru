# 画像貼り付け(Paste & Transform)機能

- ステータス: 設計(未着手)
- 最終更新: 2026-07-06

## 概要

アセット詳細モーダルのペイント/マスク編集エリアに画像を**ドラッグ&ドロップ**(または Ctrl+V / ファイル選択)で貼り付け、**移動・回転・拡大縮小**してから確定すると既存のペイントレイヤーに焼き込まれる。以降は通常のペイント結果と同一の扱いになり、既存の `paint-save`(`savePaintResultAsSourceAsset`、`generationController.ts:636-705`)で「元画像+レイヤー合成 → PNG → POST /api/projects/:id/source-assets → img2img draft 接続」がそのまま機能する。**サーバ/API は一切変更しない**。

## 設計の経緯(3案比較)

独立に設計した 3 案を 2 レンズ(コードベース適合性・UX)で審査した:

| 案 | 骨格 | 適合性審査 | UX審査 |
|---|---|---|---|
| A: 最小統合 | 単一浮遊オブジェクト、確定でレイヤーへ焼き込み。ギズモも canvas 描画 | **勝者**(fit 9 / risk 最小) | 配置プレビューが opacity 0.58 に沈む・浮遊中 Ctrl+Z=全キャンセルが弱点 |
| B: オブジェクトレイヤー | 複数オブジェクトを保存まで非破壊保持、undo をストロークと時系列統合 | 実装リスク最大(export 済み `paintUndoStacks` の全置換、変更14ファイル) | **勝者**(複数素材の反復調整に唯一正面から応える) |
| C: UX最優先 | 単一オブジェクト+SVG オーバーレイ表示、操作の磨き込み特化 | 表示層は最良、表面積は大きめ | 瞬間の操作感は最良(表層は他案へ移植可能) |

**採用: A の骨格 + C の表示・操作層 + 両審査員の移植推奨事項**。両審査員とも「浮遊中の表示を opacity 0.58 の `#paintCanvas`(`editors.css:219`、実コード確認済み)に沈めない」ことを必須級とし、C の SVG オーバーレイ移植で解消する。B の非破壊複数オブジェクトは骨格ごと後付けできないため、採否を未決事項 #1 として明示する(下記)。

## 現状の土台(調査で確認済みの事実)

- ペイント編集(`state.paintEditMode`)は natural-size の `#paintCanvas` を `#previewImage` に重ね、真実は module ローカルの `paintLayerCache`(`paintEditorController.ts:19`)。再レンダー(domMorph は canvas の width/height 属性を剥がして内容を消す)後は render 末尾の `syncAssetModalPaintCanvas()`(`main.ts:592`)が毎回復元する
- 座標変換は `pointerToMaskCanvasPoint`(`maskCanvas.ts`)が fit×zoom×pan を `getBoundingClientRect` 比で自動吸収。**成立条件は「`.mask-zoom-stage` の CSS transform が translate+scale のみ」**(回転を CSS に入れてはならない)
- pointer 分岐チェーン(`main.ts:420-438`): pose → mask → workflowDiagram → ボタンフィルタ → paint → maskStroke。keydown は Escape カスケード(`main.ts:360-373`)→ `handlePaintEditorKeydown`(`main.ts:401`)の順
- `registerEventBinder`(`actionRegistry.ts:31-33`)は**現在登録者ゼロ**。本機能が初の実利用となる
- クライアントに dragover/drop/paste リスナは皆無 → 現状ウィンドウへのファイルドロップは**ページ遷移でアプリ離脱**する(window ガード必須)
- undo は canvas スナップショットのリング(上限 5、`PAINT_UNDO_STACK_LIMIT`)
- **既知バグ(フェーズ0対象)**: ペイントモード中の中ボタンパンは `finishImagePan`(`maskEditorController.ts:357-384`)が常に `InpaintDraft.panOffset` へ保存する一方、render は `PaintDraft.panOffset` を読む(`assetModal.ts:82-84`)ため、pointerup 直後にパンが元へ戻る(snap-back)。実コードで確認済み

## 設計

### (a) モードの位置づけ

第3モードは作らず**ペイント編集モード内の機能**とする。`PaintToolKind` は変更せず、**浮遊オブジェクトの存在自体を「配置中」状態として `draft.tool` と直交させる**(C 案。previousTool 退避や Alt スポイト排他の副作用を避ける)。

- 入口はモードに縛らない: モーダル表示中ならドロップを常時受け付け、**マスク編集中/非編集中は自動でペイント編集へ切替**(既存排他遷移+トースト「ペイント編集に切り替えて貼り付けました」)。InpaintDraft・マスクレイヤーは維持される
- 浮遊中のブラシストロークは**ブロック**(canvas への pointerdown を吸収し確定 UI をパルス)。配置中の誤描画を構造的に排除
- モーダル非表示画面へのドロップは preventDefault のみ+案内トースト

### (b) データモデルと確定・undo

```ts
// 新規 src/client/pasteTypes.ts(DOM 非依存)
export interface PasteTransform {
  x: number;        // オブジェクト中心の natural px
  y: number;
  scale: number;    // 一様スケール(縮小可)。clamp: 変形後長辺 >= 8px 〜 短辺 <= canvas長辺×4
  rotation: number; // ラジアン
}
export interface PastedObjectDraft {
  objectId: string;      // crypto.randomUUID()
  sourceWidth: number;   // 取り込み後ビットマップ px(長辺 4096 へダウンスケールキャップ)
  sourceHeight: number;
  blobUrl: string;       // SVG <image href> 用。view が controller を import せず宣言的に描くため draft に置く
  transform: PasteTransform;
}
export const PASTE_MAX_SOURCE_DIMENSION = 4096;
export const PASTE_ROTATION_SNAP_DEG = 15;
export const PASTE_TRANSFORM_HISTORY_LIMIT = 50;
```

- `PaintDraft` に `pastedObject: PastedObjectDraft | null` を追加(normalize 対応。`paintDrafts` の localStorage 非永続方針はそのまま)。ビットマップ本体は module ローカル `pasteSessions: Map<assetId, { bitmap, history }>`(`paintLayerCache` と同型)に分離
- C 案の設計穴(view 層が module ローカルの blobUrl に触れない)は **blobUrl を draft に持たせる**ことで解消: 文字列なので state に置け、view は draft のみから SVG を組める。revoke は dispose 時
- 同時に持てるオブジェクトは **1 個**。浮遊中に別画像をドロップしたら現在のを自動確定してから新規配置(トーストで明示)
- **確定(ラスタライズ)** `confirmPastedObject(assetId)`: ①`pushPaintUndoSnapshot`(既存リングに 1 手として乗せる)→ ②レイヤーへ `translate·rotate·scale` 付き `drawImage`(`imageSmoothingQuality="high"`)→ ③変形後 bbox の dirtyRect で可視 canvas 再描画 → ④dispose+`requestRender()`
- 確定契機: **Enter / ✓ボタン / オブジェクトのダブルクリック / `commitActivePaintCanvas()` の先頭に統合**(→ `paint-save`(`generationController.ts:643`)とペイントモード OFF の両方を 1 箇所で吸収)/ 別画像ドロップ前 / モーダル close 前。**オブジェクト外クリックでは確定しない**(誤確定防止。ストロークブロック+パルスのみ)
- キャンセル: Esc / ✗ボタン。レイヤー無変更で dispose のみ
- **undo の 2 層構造**: 浮遊中は `history: PasteTransform[]`(上限 50、pose 型の軽量 undo)を Ctrl+Z で巻き戻し、履歴が尽きたら次の Ctrl+Z で貼り付け自体をキャンセル。確定後は既存 snapshot undo で 1 手戻し。**`paintUndoStacks` の構造は変えない**
- 整合ガード: sync 時に `draft.pastedObject` があるのに session が無ければ draft 側を null へ(stale 対策)

### (c) 入力経路(DnD / クリップボード / ファイル選択)

`registerEventBinder` 初利用として `pasteController.ts` が配線(リスナは window / `#app` へ):

1. **window ガード(常時)**: `dragover`/`drop` で `preventDefault()`(アプリ離脱防止)。受け入れ可能時のみ `dropEffect="copy"`
2. **OS ファイル D&D**: `dataTransfer.files` 先頭のみ採用(複数時は「1 枚目のみ貼り付けました」トースト)。MIME は `uploadSourceAsset` と同じ **png/jpeg/webp** whitelist+同一文言のエラートースト
3. **アプリ内サムネイル D&D**: `#app` への `dragstart` 委譲で `dataTransfer.setData("application/x-guruguru-asset-id", assetId)` を仕込み、drop 側はこれを最優先、`text/uri-list` から assetId 抽出をフォールバックとする。**必ず assetId を解決して `/api/assets/:id/image`(フル解像度・same-origin)を fetch する** — uri-list の URL 直 fetch はサムネイル縮小版を貼ってしまうため禁止。「前の生成結果をこの画像に合成」が D&D 一発になる本機能の隠れた主役
4. **Ctrl+V**: window `paste` リスナ。`state.activeAssetId` あり かつ `isTextEntryTarget` でないとき(`isTextEntryTarget` は `main.ts:500-508` から `clientUtils.ts` へ移設して共用)。配置は canvas 中央
5. **ファイル選択ボタン**: paintPanel に `data-action="paste-pick-file"`(動的 `input type=file`)。D&D を知らないユーザーの発見性担保。アイコンは `iconImage()` 再利用(galleryView で使用中の既存アイコン)
6. **taint 安全の統一経路**: すべて File/Blob → `createImageBitmap`(fallback: blob URL + Image)→ offscreen canvas 複製。**リモート URL の `<img>` を直接 drawImage する経路は作らない**(レイヤー taint で `toDataURL`/スポイトが全滅するため)。File なし・cross-origin URL のみのドロップは拒否+トースト
7. **フィードバック**: dragenter/leave で `.preview-media` に `.paste-drop-active` ハイライト(classList 直接操作、render 不要。マスク編集中は文言を出し分け)。decode 150ms 超のみ「読み込み中…」トースト。非対応形式・巨大画像は行動可能な文言でエラートースト

**初期配置**: drop 座標を `pointerToMaskCanvasPoint` で natural 化しオブジェクト中心に(canvas 外はクランプ)。モード自動切替直後で `#paintCanvas` が未サイズの場合(画像 load 待ち)は **pending 配置**として保持し、切替後の sync で配置。初期 `scale = min(1, 0.9·canvasW/srcW, 0.9·canvasH/srcH)`(拡大しない)。

### (d) 変形 UI(ギズモ)

**SVG オーバーレイ方式**(canvas 描画ではなく)。理由: ①`.mask-canvas` の opacity 0.58 を継承せず**浮遊中は全不透明**で精密配置でき、確定で 0.58 表示に落ちる変化が「確定した」フィードバックになる ②ジェスチャ中の更新が `<g transform>` 属性 1 本で canvas 再合成ゼロ ③`vector-effect: non-scaling-stroke`(pose/websam の既存前例)で zoom 中も線幅一定。

- `renderPreviewMedia`(`assetModal.ts:136-145`)に `paintEditing && paintDraft.pastedObject` のとき `<svg id="pasteOverlay" viewBox="0 0 W H">` を出力: `<g id="pasteObjectGroup" transform="...">` 内に `<image href={blobUrl}>`+破線枠、g の外に 4 隅スケールハンドル+回転ハンドル(g 内に置くと scale でハンドルが伸縮するため)。**id 付きなので domMorph で保持**され、`href`/`transform` はテンプレート由来なので morph に剥がされない
- ハンドル位置・半径は毎 render 後の `syncPasteOverlay()`(`main.ts:592` の直後に 1 行)で `r = 6 × canvas.width / rect.width` 換算。wheel zoom tick は render を経ないため `handlePaintWheelZoom`(`paintEditorController.ts:30-61`)の setProperty 直後に `syncPasteGizmoScale()` を 1 行フック
- SVG root は `pointer-events:none`、`<image>`/ハンドルのみ `pointer-events:auto`。ヒットは要素ヒット(`data-paste-handle` closest、pose の `.pose-joint` 方式)で逆行列不要
- **操作体系**:

| 操作 | ジェスチャ | 修飾キー |
|---|---|---|
| 移動 | `<image>` ドラッグ | Shift = 水平/垂直軸ロック |
| 拡大縮小 | 4 隅ハンドル。中心アンカーの一様スケール(縮小可) | アスペクト常時固定(修飾キー不要) |
| 回転 | 上辺の回転ハンドル(`atan2` 差分) | Shift = 15° スナップ。ダブルクリックで 0° |
| 微調整 | 矢印キー 1px / Shift+矢印 10px | |
| 確定 / キャンセル | Enter・✓・オブジェクト dblclick / Esc・✗ | |
| ズーム/パン | 既存のまま(wheel=ビューズーム、中ボタン=パン。オブジェクト操作に奪わない) | |

- **ジェスチャ中は `requestRender()` しない**: rAF バッチで SVG 属性直更新のみ、pointerup で draft へ確定+`requestRender()`(pose の `applyPoseDragToSvg` と同一規約)。pointer capture は try/catch、pointerId 照合、pointercancel は開始時 transform へ巻き戻し
- 回転は **SVG group / canvas 2D transform 内のみ**。CSS transform には一切入れない(座標変換の成立条件)
- カーソル: `<image>`=move、スケールハンドル=`nwse/nesw-resize`、回転=`grab/grabbing`
- パネル表示: 浮遊中のみ paintPanel に「貼り付け中」セクション(確定/キャンセルボタン+スケール%・回転角の読み出し+ヒント文)。読み出しはジェスチャ中 `data-value-target` 方式で直接更新

**イベント配線**: pointerdown/move/up/cancel は `handlePaintEditorPointerDown` 等の**直前**に `handlePastePointerDown` 等を各 1 行挿入(`main.ts:434` 前後。ボタンフィルタ通過後なので button 0 のみ)。keydown(Enter/矢印/浮遊中 Ctrl+Z)は `handlePaintEditorKeydown` の先頭から内部呼び出し(main.ts 無変更)。**Esc のみ特別扱い**: `main.ts:360-373` の Escape カスケードに `deletePreviewRoundId` 分岐の直後で `else if (cancelPastedObjectIfAny())` を挿入(①削除プレビュー閉 → ②貼り付けキャンセル → ③モーダル閉、の 3 段)。

### (e) 再レンダー(domMorph)を跨いだ状態保持

| 資産 | 戦略 |
|---|---|
| ビットマップ / 変形履歴 | module ローカル `pasteSessions`(morph の外) |
| 変形値・blobUrl | `PaintDraft.pastedObject`(state)。ジェスチャ中は state を触らず SVG 直更新、pointerup で確定 |
| SVG ノード | id キーで morph が同一ノード維持。属性はテンプレート出力+毎 render 後 sync で常に整合 |
| `#paintCanvas` の消去 | 影響なし(浮遊画像は canvas に描かない。レイヤー復元は既存 sync のまま) |

後始末: `closeAssetDetail` で自動確定(作業を失わせない。Esc 経由はカスケードが先にキャンセルを消費するので「閉じたら勝手に焼き込み」は起きない)/ `paint-save` 成功時に dispose / プロジェクト切替時に `disposeAllPasteSessions()`(blobUrl リーク防止。draftStore→pasteController の import 方向が規約上問題ないか実装時確認、不可なら callback 登録方式)。

### (f) 保存との合流・16MB 制限

- `commitActivePaintCanvas()` 先頭への確定統合により、`savePaintResultAsSourceAsset` の合成(`composePaintResultCanvas` の 2 層合成)は**無変更**で貼り付け結果を含む。POST body・ファイル名・templateId 解決・refreshProject もすべて既存のまま
- **16MB プリフライト(既存 paint-save にも効く純改善)**: POST 前に `dataUrl.length` をサーバ側ガード(`uploadDataUrl.ts` の `maxSourceImageBytes` 16MB × base64 係数 1.4)相当のクライアント定数と比較し、超過時は送信せず「合成結果が 16MB を超えています。画像サイズを縮小してください」を即時トースト
- 出力解像度は常に基底画像 natural size のままなので、413 リスクの構造は既存 paint-save と同一(写真貼り付けで PNG が肥大しやすくなる点のみ。JPEG フォールバックは Feature-PaintTool.md の未決事項と共通の将来課題)

### (g) 実装フェーズ分割

ブランチ: `feature/image-paste-N-<slug>`(git worktree、main チェックアウト維持)。各フェーズで `npm run typecheck` / `npm test` / `$env:GURUGURU_TEST_DB='1'; npm run check` / `git diff --check`。UI 確認は 1680×920 viewport・非 5177 ポート+`GURUGURU_TEST_DB=1`。回転/スケールの動作検証は claude-in-chrome(第二次リファクタリングで確立した手法)。

- **フェーズ 0(事前バグ修正・要ユーザー確認)**: ペイントモード中パンの snap-back 修正。`beginImagePan`/`finishImagePan`(`maskEditorController.ts:326-384`)に `state.paintEditMode` 時は `PaintDraft.panOffset` を読み書きする分岐を追加。貼り付け配置はパンを多用するため先に潰す。既存挙動の変更なので単独コミット
- **フェーズ 1: 型+pure helper+テスト**: `pasteTypes.ts` / `pasteTransform.ts`(変形 4 頂点・変形後 bbox・逆変換ヒットテスト・中心アンカースケール式・回転スナップ・クランプ・初期 fit・ナッジ)+ `pasteTransform.test.ts`(node:test、DOM-free)。`PaintDraft.pastedObject` 追加+normalize+`paintDraft.test.ts` 追記
- **フェーズ 2: 取り込み+表示+確定/キャンセル(変形なし)**: `pasteController.ts`(window ガード、File decode、4096 キャップ、モード自動切替、pending 配置、失敗トースト)、`views/pasteOverlay.ts`+`assetModal.ts` 組み込み+`syncPasteOverlay()`、パネルの確定/キャンセル UI、`commitActivePaintCanvas` への確定統合、確定=snapshot 1 手、Esc カスケード挿入、close/保存時の後始末、ストロークブロック。**この時点で「ドロップ → その場に表示 → 確定 → 保存」が成立**
- **フェーズ 3: 変形ジェスチャ+キーボード**: move/scale/rotate(rAF+SVG 直更新、pointerup で draft 確定)、Shift 軸ロック/15° スナップ/dblclick 0° リセット、矢印ナッジ、浮遊中 Ctrl+Z(transform 履歴→尽きたらキャンセル)、wheel tick のギズモ再 sync フック、カーソル群、%/角度読み出し
- **フェーズ 4: 入力経路拡張+polish**: アプリ内サムネイル dragstart(`application/x-guruguru-asset-id`)+フル解像度 fetch、Ctrl+V(`isTextEntryTarget` の clientUtils 移設込み)、`paste-pick-file` ボタン、ドロップハイライト+文言出し分け、複数ファイル方針、150ms 遅延ローディングトースト、16MB プリフライト、`shortcuts.ts` 追記、`操作メモ.md` 更新

### 触るファイル一覧

| ファイル | 変更概要 |
|---|---|
| **新規** `src/client/pasteTypes.ts` | 型・定数(DOM 非依存) |
| **新規** `src/client/pasteTransform.ts`(+`.test.ts`) | 変形数学・ヒット判定の pure helper |
| **新規** `src/client/pasteController.ts` | session Map、DnD/paste 配線(registerEventBinder 初利用)、ジェスチャ、confirm/cancel、registerActions |
| **新規** `src/client/views/pasteOverlay.ts` | SVG ギズモ render helper |
| `paintTypes.ts` / `paintDraft.ts`(+test) | `pastedObject` 追加・normalize |
| `views/assetModal.ts` | オーバーレイ出力(`renderPreviewMedia`) |
| `views/paintPanel.ts` | 貼り付けボタン+浮遊中セクション |
| `main.ts` | pointer 分岐 4 行・Esc カスケード 1 分岐・`syncPasteOverlay()` 1 行・import(新規関数は追加しない) |
| `paintEditorController.ts` | `commitActivePaintCanvas` 先頭の確定統合、wheel フック 1 行、`pushPaintUndoSnapshot` export 化 |
| `maskEditorController.ts` | フェーズ 0 のパン書き先分岐のみ |
| `generationController.ts` | 16MB プリフライト、保存成功時 dispose |
| `assetDetailController.ts` | close 時の自動確定 |
| `draftStore.ts` | プロジェクト切替時 disposeAll |
| `clientUtils.ts` | `isTextEntryTarget` 移設 |
| `shortcuts.ts` / `styles/editors.css` | ヘルプ追記 / `.paste-*` 一式(non-scaling-stroke、ハイライト) |

### (h) 変えないこと(不変条件)

1. **マスク編集の全挙動**(ツール・WebSAM・ポーズ・InpaintDraft の意味。フェーズ 0 は paintEditMode 分岐の追加のみでマスクモードのパン経路は不変)
2. **ブラシ/消しゴム/スポイトのストローク経路**(rAF+dirtyRect パイプライン。浮遊中の入口ブロックのみ)
3. **wheel=ビューズーム、中ボタン=パン**の意味とズーム範囲 0.25–4
4. **`.mask-zoom-stage` の CSS transform は translate+scale のみ**(回転を入れない — 座標変換の成立条件)
5. `.mask-canvas` の opacity 0.58・canvas backing=natural px・devicePixelRatio 非使用
6. **保存 API 契約**(body 形式・PNG 固定・`decodeImageDataUrl` の検証)とサーバコード全体
7. `paintUndoStacks` の snapshot 方式・上限 5(確定は 1 snapshot として乗るだけ)
8. paintDrafts の localStorage 非永続方針
9. 既存 pointer/keydown チェーンの相対順序(挿入のみ、並べ替えなし)。Esc の最終的な意味(モーダルを閉じる)

## 実装時の検証ポイント(残リスク)

- SVG `<image>` と canvas `drawImage` の補間差による確定時のわずかな見た目変化(実害なし想定だが確認する)
- モード自動切替を伴うドロップでの pending 配置タイミング(フェーズ 2 で最初に検証)
- draftStore → pasteController の import 方向(循環になる場合は callback 登録へ)
- ジェスチャ確定時の dirtyRect(旧 bbox ∪ 新 bbox+margin)で 4K 画像でも重くないこと

## 未決事項(実装前にユーザー確認)

1. **【最重要・審査が割れた点】確定式(採用案) vs 非破壊オブジェクトレイヤー(B 案)**: 採用案は「1 枚浮遊 → 確定で焼き込み」で、確定後の再調整は snapshot undo(5 段)が上限。複数素材を貼って**後から 1 枚目だけ再調整**するワークフローを重視するなら B 案(保存まで全オブジェクト再編集可・複数枚・重ね順)が構造的に優るが、既存 undo 機構の置換を含む大改修(変更 14 ファイル)になる。**推奨は採用案で小さく出し、実運用で複数素材の再調整が頻出したら B 案へ拡張検討**(その場合 `pasteTransform.ts` の幾何層はそのまま流用可)
2. フェーズ 0 のパン snap-back 修正を先行してよいか(既存挙動の変更)
3. モーダル close 時の浮遊オブジェクトは「自動確定」(採用)か「破棄」か
4. 対応形式は png/jpeg/webp(既存アップロードと同一 whitelist、採用)で良いか。GIF(先頭フレーム)等へ広げるか
5. フローティング確定バー(オブジェクト追従の ✓/✗ ピル、C 案)を追加するか、パネル内の確定 UI のみ(採用)で足りるか

## 変更履歴

- 2026-07-06: 起票。3 案(最小統合/オブジェクトレイヤー/UX 最優先)の独立設計と 2 レンズ審査を経た統合設計の初版。
