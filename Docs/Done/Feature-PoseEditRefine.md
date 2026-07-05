# Feature: ポーズ編集の改善（Undo / エッジ削除UX / CIGPose自動有効化 / タブ添付チェック / FK）

`feature/pose-edit-improvements`。ユーザー要望 7 件をまとめて対応する。

## 対象要望

1. **ポーズ編集で Ctrl+Z（Undo）が効かない** → ポーズ編集専用の Undo スタックを追加。
2. **エッジが消えるのが容易すぎる** → 関節1クリックの即時 visible トグル削除を廃止。ボーン（エッジ）をクリックで選択し、中点に出る `×` ボタンで初めて削除する 2 段階操作にする。非表示関節はクリックで復帰可。
3. **キャッシュ済みモデル（CIGPose X）が再試行を押さないと有効化できない** → ポーズタブ表示・モデル切替時に OPFS キャッシュを probe し、キャッシュ済みなら自動でロード（未取得モデルは自動ダウンロードしない）。
4. **グリッド select の "4x4" 表記** → "4列" に統一（2列/3列と表記を揃える）。
5. **ポーズとマスクを独立して ON/OFF** → マスク添付（`InpaintDraft.enabled`）をマスク編集モードの開閉から分離。各レイヤーは独立トグル。
6. **pose の「次回生成に添付する」チェックをタブへ移設** → 右サイドバーの「マスク / ポーズ」タブそれぞれにチェックボックスを付け、添付有効／無効をタブ上で示す。
7. **FK（フォワードキネマティクス）** → `Alt + ドラッグ` で、掴んだ関節を親中心に回転（骨長固定）させ、その子孫関節すべてを同じ角度で剛体回転させる（回転FK）。

## 操作モデル（ポーズ編集）

### 単一関節
- **関節ドラッグ**: 単一関節を自由移動（従来どおり）。
- **Shift + 関節ドラッグ**: 単一ボーンを親中心に回転（骨長固定・子孫は追従しない、従来どおり）。
- **Alt + 関節ドラッグ（新）**: 回転FK。掴んだ関節＋その子孫を親中心に同角度回転。ルート関節（neck）は親が無いため全身平行移動にフォールバック。
- **非表示関節クリック**: `visible` を復帰（表示方向のトグルのみ残す）。表示中の関節クリックは何もしない（誤削除防止）。

### エッジ（ボーン）選択・マルチ選択
- **エッジクリック**: そのボーンを単独選択（掴んだままドラッグで移動も可能）。
- **Shift + エッジクリック**: 選択集合へ追加/除外（トグル）。
- **空き領域ドラッグ**: 矩形（ラバーバンド）で範囲選択。中点が矩形内のボーンを選択（最多ヒットの1人物に限定）。Shift 併用で追加。
- **選択エッジをドラッグ**: 選択集合を **一括平行移動**。**Shift / Alt 併用で回転FK**（最も浅い選択関節をヒンジに固定し、選択関節＋子孫を剛体回転）。
- **削除**: 選択中は選択ボーン中点の重心に `×` を1つ表示。`×` または **Delete/Backspace** で選択中のエッジを一括削除（`PoseDraft.removedBones`）。
- **空クリック**: 選択解除。

### 共通
- **Ctrl/Cmd+Z**: 直前のポーズ編集（移動 / FK / 一括移動・回転 / エッジ削除 / 関節復帰）を1手戻す。

## 追加のマスク編集画面調整（同ブランチ）

1. マスク編集ではマスクが主要要素のため、`Masked content` / `Inpaint area` / `Only masked padding` / `Mask feather` をブラシサイズ直下（`.mask-content-controls`）へ移動。Positive prompt/バッチ/生成パラメータはその下。
2. 左サイドバーのタブから重複していた「点クリア」を削除（右パネルに同機能あり）。
3. マスク編集モードのインジケータから「ブラシ / 48px」表示（tool/size）を削除。

## データモデル変更

- `PoseDraft.removedBones?: number[][]` を追加。人物 index ごとに削除済み `OPENPOSE_BONES` の index 配列。`renderPoseOverlay` とスケルトン PNG（`buildPoseSkeletonDrawOps`）の両方で描画対象外にする＝ControlNet 添付画像からも除外される。
- `normalizePoseDraft` で後方互換に正規化（未定義は空扱い）。
- モジュール状態 `selectedPoseEdges: { poseIndex, boneIndex }[]`（選択中エッジ集合・同一人物のみ）を追加。asset/タブ/編集モード切替・再検出・関節移動で解除。
- ドラッグ状態 `activePoseSelectionDrag`（一括移動/回転FK）・`activePoseMarquee`（矩形選択）を追加。いずれも一時状態で永続化しない。

## CIGPose 自動有効化（probe）

- worker プロトコルに `probe-cache`（req）/ `cache-status`（res）を追加。両 worker（mediapipe/cigpose）で OPFS のファイル存在のみを確認し、セッションは作らない。
- main.ts: ポーズタブ表示・モデル切替時に probe。`cached=true` かつ未ロードなら `loadActivePoseModel()` を自動実行（キャッシュ済みなので即 initializing→ready）。`cached=false` は `not-cached` を表示して自動DLはしない。

## マスク/ポーズ独立化

- `toggleMaskEditor()` は `enabled` を触らない（編集モードの開閉と添付状態を分離）。`openAssetDetail` は編集モードを常に閉じた状態で開く。
- 添付は各タブのチェックボックスで制御（mask=`InpaintDraft.enabled`, pose=`PoseDraft.enabled`）。マスク「適用」・ポーズ検出成功時は従来どおり `enabled=true`。
- 生成時の添付判定（`inpaintRequestForParent` / `controlnetRequestForParent`）は従来どおり `enabled` を参照するため、編集モードに依存せず独立して効く。

## 変更ファイル

- `src/client/views/galleryView.ts` — "4x4" → "4列"
- `src/client/poseTypes.ts` — `PoseDraft.removedBones`
- `src/client/poseDraft.ts` — `poseDescendants` / `rotatePointAround` / `clonePoses` / `isBoneRemoved` / `withRemovedBone` / `normalizePoseDraft`
- `src/client/poseSkeleton.ts` — `buildPoseSkeletonDrawOps(removedBones)`
- `src/client/views/posePanel.ts` — オーバーレイ（hit line / removed 除外 / エッジ×）・「次回生成に添付する」削除・操作ヒント
- `src/client/views/assetModal.ts` — タブのチェックボックス
- `src/client/pose/types.ts` — probe-cache / cache-status
- `src/client/pose/worker.ts`, `src/client/pose/cigposeWorker.ts` — probe 実装
- `src/client/main.ts` — Undo スタック / エッジ選択・削除 / FK ドラッグ / 独立化 / タブチェック / probe 配線 / Ctrl+Z

## テスト

- `poseDraft.test.ts` — `poseDescendants` / `rotatePointAround` / `withRemovedBone` / 正規化
- `poseSkeleton.test.ts` — `removedBones` 指定時に該当 bone を描画しない
