# マスクペンのかくつき修正（HW アクセラレーション無効環境）

- ステータス: 設計（未着手）
- 最終更新: 2026-07-02

## 症状

Chrome のハードウェアアクセラレーションが無効な環境で、マスク編集のペンツールがかくつく。選択（塗り）領域の描画がマウスカーソルに追いつかない。

## 原因（コード調査で特定済み・寄与順）

1. **pointermove 毎の全面再合成**: `drawMaskSegment`（`main.ts:2226-2247`）が 1 イベントごとに `renderFinalMaskToCanvas`（`maskCanvas.ts:67-80`）を呼び、`clearRect` + 全面 `drawImage` ×3（samMask / manualInclude / manualErase）を画像 natural 解像度で実行する。`getCoalescedEvents` は不使用（src/client 全体で grep 0 件）、`requestAnimationFrame` もスクロール復元用の 1 件（`main.ts:1674`）のみで描画バッチには不使用のため、高レートマウス（500〜1000Hz）では 1 フレームに複数回の全面合成が走る。CSS 側でさらに `width:100%` + `scale(--mask-zoom)` のリスケールが乗るため、ソフトウェアレンダリングでは致命的
2. **pointerdown 時の同期フルコミット**: `beginMaskStroke`（`main.ts:2175-2193`）が manual 系ストローク開始時に `commitMaskCanvas` を呼ぶ → `commitMaskLayers`（`main.ts:1826-1841`）が `canvasHasMaskPixels`（全画素 `getImageData` 走査、`maskCanvas.ts:131-144`）× 4 layer + `toDataURL("image/png")`（PNG エンコード）最大 5 回 + `composeFinalMaskDataUrl` を**同期**実行。描き始めに数百 ms 級のスパイクになり得る
3. **ホイールズームの全再描画**: `handleMaskWheelZoom`（`main.ts:3007-3020`）が 1 tick ごとに `setInpaintDraft` + `render()`（app 全体の innerHTML 再構築 + `syncAssetModalMaskCanvas` での canvas 再生成・layer 再描画）
4. （軽微）毎 pointermove の `updateMaskBrushCursor`（`main.ts:1757-1787`）が `document.querySelector` + SVG 属性更新

なおストローク中に `render()` は呼ばれておらず（これは正しい）、`paintStroke` 自体（1 線分の stroke、`maskCanvas.ts:106-129`）は軽い。問題は合成と同期コミット。

## 修正計画（効果順・独立コミット）

### A. pointerdown 同期コミットの除去/遅延

- `beginMaskStroke` の `commitMaskCanvas` 呼び出し（`main.ts:2190-2192`）を削除し、コミットは `finishMaskStroke`（`main.ts:2209-2224`）→ `commitActiveMaskCanvas`（`main.ts:2249-2254`）のみにする
- **着手前に意図を調査**: down 時コミットが MASK バッジ即時反映や draft.enabled 初期化のためであれば、`enabled` フラグ更新など軽量処理だけを残す。挙動差（ストローク途中でタブが落ちた場合の draft 消失など）は許容範囲として記録

### B. rAF バッチ + getCoalescedEvents

- `ActiveMaskStroke`（`maskTypes.ts:59-64`）に pending points queue を追加。pointermove では `event.getCoalescedEvents()` で全ポイントを queue に積むだけにする（描画しない）
- `requestAnimationFrame` コールバックで queue 内の全線分を `paintStroke` で一括描画し、**再合成は 1 フレーム 1 回**だけ実行
- ストローク軌跡の忠実さは coalesced events で従来以上になる（現状はフレーム落ち時に線分が直線化する）

### C. ダーティ矩形合成（full repaint の廃止）

- `renderFinalMaskToCanvas` に省略可能な `dirtyRect` 引数を追加: そのフレームで描いた線分群の bbox + ブラシ半径 + マージンに `clearRect` / 9 引数 `drawImage`（sub-rect 指定）を限定する
- 全面合成は commit 時・`syncAssetModalMaskCanvas`（`main.ts:1702-1748`）・SAM プレビュー適用時のみ
- 4K 級画像での 1 フレームあたりの合成コストがブラシ周辺のみになる

### D. ホイールズームの軽量化

- tick ごとの `render()` をやめ、CSS 変数を**直接更新**する。CSS 変数の設置場所は `.preview-media` の inline style（`assetModal.ts:52・84`）で、`.mask-zoom-stage` の transform（`styles.css:1871-1877`）が消費する。ズームも**`.preview-media` へ `setProperty`** で更新する（パン中の直接更新 `continueImagePan` `main.ts:2110-2123` と同方式。設置先を `.mask-zoom-stage` にすると `finishImagePan` `main.ts:2125-2152` の読み戻しと不整合になるので不可）
- wheel idle（~150ms）後に draft へ永続化 + `render()` 1 回（`finishImagePan` の永続化パターンに合わせる）

### E. カーソル要素参照のキャッシュ

- `updateMaskBrushCursor` の `document.querySelector` をストローク/セッション単位でキャッシュ（`render()` 後に無効化）

## 検証

- **挙動固定**: 同一ストローク入力に対する最終 `maskDataUrl` の合成結果が修正前後で同一であること（合成式・白 strokeStyle・`destination-out` の意味論は非接触）。`maskCanvas.geometry.test.ts` の既存テスト維持 + queue/dirtyRect の pure 部分をユニットテスト化
- **再現環境**: `chrome://settings` でハードウェアアクセラレーション OFF、または `--disable-gpu` 起動。DevTools Performance で pointermove〜描画の 1 フレーム処理時間を計測（目標: 8ms 以下/フレーム）
- **brush-prompt への影響**: SAM の brush-prompt ストロークも `drawMaskSegment` 経路を通る。バッチ化後も `sampleBrushPromptPoints`（`maskCanvas.ts:170-189`、間隔 48px・最大 48 点）のサンプリング結果が変わらないこと
- 消しゴム時の `removeBrushPromptPointsNearSegment`（`main.ts:1950-`）がイベント毎 → rAF 毎になるが、線分単位の距離判定は維持されるため影響なしを確認
- UI 確認は 1680x920 viewport、テスト起動は非 5177 ポート + `GURUGURU_TEST_DB=1`

## 変えないこと

- マスク合成式・レイヤー構造（`MaskLayerSet` 5 layer）・白 strokeStyle・ブラシ形状（round cap/join）
- `InpaintDraft` の保存形式・commit 後の dataURL 内容
- pointer capture / `touch-action: none` / 右クリック消しゴムなどの操作系

## 備考

- ペイントツール（`Feature-PaintTool.md`）は同じ描画パスを流用するため、**本修正を先に入れる**ことを推奨（Docs/README.md の実装順）
- ズーム時のカーソル追従など既存の座標変換（`pointerToMaskCanvasPoint`）は getBoundingClientRect ベースで zoom/pan を自動吸収しており、本修正では触らない

## 変更履歴

- 2026-07-02: 起票。原因調査結果と修正計画 A〜E の初版。
