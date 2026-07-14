# マスク・ポーズ添付パイプライン リファレンス

生成時に「元画像+add-on」を ComfyUI へ渡す添付パイプライン(マスク編集/inpaint と ポーズ ControlNet 添付)の内部実装メモ。運用手順・落とし穴の一覧は `操作メモ.md`、機能ごとの設計経緯は `Docs/Done/` を参照。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## マスク・inpaint

- 通常の img2img は、親画像を指定した幅・高さへ `ImageScale` でリサイズしてから `VAEEncode` に渡す。フォームの幅・高さは EmptyLatent ではなく、このリサイズノードで実際の出力サイズに反映される。
- マスク付き inpaint は、保存時のマスク寸法が親画像と一致していることを検証したうえで、生成時に親画像とマスクを同じ指定幅・高さへリサイズしてから `VAEEncode` / 合成へ渡す。
- 画像詳細ビューアのマスク編集は、親画像と同じサイズの PNG マスクだけを生成リクエストに使う。
- GURUGURU が生成するマスク PNG は透明背景に白で描画する。ComfyUI の `LoadImageMask` は alpha を反転マスクとして読むため、workflow patch では `red` チャンネルを使い、白い描画部分を更新対象にする。
- スマート選択で WebSAM / SlimSAM-77 を使う場合、既定ではローカルAPI `/api/websam-models` 経由で GitHub Release `websam-models-v1` の `slimsam-77-encoder.onnx` と `slimsam-77-decoder.onnx` を取得する。別の配布先を使う場合だけ、設定画面の `WebSAM model base URL` を変更する。
- 公開GitHub Release Assetから取得するため、`GURUGURU_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`などの認証設定は不要。
- サーバーのrelease asset proxy(`src/server/index.ts`の`serveReleaseAsset`)は「ファイル名 → 公開release download base URL」のレジストリ方式。WebSAM用(`slimsam-77-encoder.onnx` / `slimsam-77-decoder.onnx` → `websam-models-v1`)に加え、ポーズ検出モデル用(`pose_landmarker_full.task` → GitHub Release `pose-models-v1`、`GET /api/pose-models/:filename`)を同じハンドラでストリーミング配信する。
- SlimSAM-77 のモデルファイルはブラウザの OPFS にキャッシュされる。2回目以降はキャッシュ済みファイルを優先する。OPFS非対応ブラウザでは手動マスク機能はそのまま使えるが、WebSAMのキャッシュは使えない。
- WebSAM decode後のlogitsはWorker内に保持し、閾値化・平滑化は`Uint8Array`のalpha（1 byte/pixel）だけで行う。RGBAへの展開とPNG Data URL化は表示直前のクライアント側だけで行い、Workerからはalphaの`ArrayBuffer`をtransferする。
- Threshold/Smoothingの連続変更はWorkerで「実行中1件+保留中の最新版1件」へcoalesceし、再処理は`selectedSamCandidateIndex`の1候補だけに限定する。`bun run benchmark:websam`の既定条件（1024×1446、Smoothing=4）で50msを超える状態が継続した場合だけRust/WASM化を再検討する。
- スマート選択の最終マスクは `finalMask = (samMask OR manualIncludeMask) AND NOT manualEraseMask` として合成し、この白黒PNGだけを `maskDataUrl` として送る。SAM候補プレビューは「適用」するまで `samMask` として確定しない。
- 手動ペン(`manual-include`)で描くときは `manualInclude` レイヤーに加えて同じストローク形状を `manualErase` レイヤーから `destination-out` で削除する。これにより「消しゴムで消した領域を後からペンで再描きして復活させる」ことができる。消しゴムは引き続き `manualErase` に追加し、SAM結果や手動追加を最終合成で抜く。
- WebSAM Brush prompt のサンプリング間隔は `BRUSH_PROMPT_POINT_SPACING`(48px)/ `BRUSH_PROMPT_MAX_POINTS`(48点)で間引く。マジックナンバーではなく定数化し、過剰な点で decode が重くなるのを防ぐ。消しゴムによる点削除(`removeBrushPromptPointsNearSegment`)はブラシ半径ベースなので間引いた後も整合する。
- マスク編集時はブラシサイズ相当の半透明円(`.brush-cursor`)を画像座標系で追従表示する。ペン=緑、消しゴム=赤、Brush prompt=青。Point/Box モードでは非表示。ズーム・パンでも画像座標とズレない(SVG overlay が `mask-zoom-stage` 内で一緒にスケールする)。
- 手動マスク操作は `maskUndoStacks` にマスクレイヤー一式と draft のマスク関連フィールドをスナップショット保存する。ストローク、消しゴム、クリア、反転、微小島除去は Ctrl/Cmd+Z またはマスクツールバーの Undo で1手戻せる。ポーズタブ表示中はポーズ編集側の Undo を優先する。
- inpaint の `maskedContent` 既定は `original`(元画像の潜在を維持 + `SetLatentNoiseMask`)。`fill`(`VAEEncodeForInpaint` でマスク部をゼロ埋め)は低デノイズで灰色ベタが残りやすいため既定から外した。UIの選択肢ラベルで灰色化の有無を明示している。統合 Switch テンプレートも 4 値すべてに対応(2026-07-06、`Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.md` 参照)。ただし content-switch ツリーを持たない旧インポート済みテンプレートでは original 以外は生成時エラーになるため、参照 JSON の再インポートが必要。
- `patchInpaintLatentPath` では、サンプラー用ノイズマスク(`GrowMask` 済み・padding 含む)と、最終 paste back 用 `ImageCompositeMasked` のマスク(元の非拡大マスク)を分離する。これにより padding 領域へ生成結果が意図より広く貼り戻されるのを防ぎ、灰色化を悪化させない。
- デノイズ強度はラウンド切替や親画像切替でも保持する。`selectRound` はフォーム全体を破棄せず `denoise` だけ引き継ぐ。`fillGenerationFormFromAsset` は既存の denoise を上書きしない(txt2img など `requiresFullDenoise` のモードを除く)。`renderGenerationPanel` の表示値は `normalizeDenoiseForMode` で正規化し、実際に送信される `request.denoise` と一致させる。
- `generation_rounds.request_json` には `maskedContent`、`inpaintArea`、`onlyMaskedPadding` と保存済みマスク参照だけを残し、巨大な `maskDataUrl` は保存しない。
- マスク画像は各 Project の外部データディレクトリ配下 `projects/<projectId>/masks/` に保存される。
- グリッドの `MASK` バッジ(`.mask-badge`)は、そのアセットに有効なマスクデータ(`hasMaskData`)さえあれば `enabled` の値に関わらず常に表示する(OFF でも再度 ON にできるように)。バッジ自体をクリックすると `InpaintDraft.enabled` を直接トグルする(詳細は「添付トグル UI」節)。
- マスク編集を OFF にした場合、描いたマスク画像は下書きとして残しても request には含めない。グリッドのプレビュー合成(`.mask-grid-preview`、マスク編集の `.mask-canvas` と同じ opacity 0.58 の白抜き表示)も OFF の間は消え、バッジは inactive(グレー)表示になる。再度 ON にすると残っている下書きがそのまま復元される。

## ポーズ ControlNet 添付

- 画像詳細ビューアのマスク編集サイドバーに「マスク / ポーズ」タブがあり、ポーズタブでは検出モデル(MediaPipe Pose Landmarker Full / Heavy、CIGPose)で検出した OpenPose 18点を関節ドラッグ・エッジ選択・マーキーで編集できる(複数人最大4人・Undo・Shift ドラッグの骨長固定 FK 対応)。編集対象は常に OpenPose 18点(MediaPipe 33 landmarks は検出直後に変換して破棄)。モデルは GitHub Release から `/api/pose-models` 経由で取得し OPFS にキャッシュする。モデル DL 進捗による再描画は `POSE_PROGRESS_RENDER_INTERVAL_MS`(150ms)でスロットルする(進捗イベントごとの全再描画でマスク/ポーズタブ切替が重くなる・ボタンが押せなくなる事象への対策)。
- ポーズタブの添付チェックを ON にした状態で生成すると、`renderPoseSkeletonDataUrl` が黒背景 + OpenPose 標準配色のスケルトン PNG を描画し、`request.controlnet.poseImageDataUrl` として送信する。**送信先テンプレートの workflowJson に `ControlNetApplyAdvanced` ノードが無い場合は添付自体を行わない**(クライアント側 capability チェック、`workflowHasControlNetApply`)。
- サーバーはマスクと同型の添付パイプラインで処理する: `decodeControlImageDataUrl`(PNG限定・8MB上限)→ `storeControlImage`(`projects/<projectId>/control/<roundId>_pose.png`)→ `uploadImageToComfy` → `patchControlNetPath`。`request_json` へ保存する前に `poseImageDataUrl` は null 化し、巨大 dataURL を DB に残さない(マスクの `maskDataUrl` null 化と同じ規約)。
- イテレーションツリーのエッジポップアウトは、保存済み `request_json` の `inpaint.maskPath` / `controlnet.poseImagePath` がある場合に `/api/rounds/:roundId/attachments/mask|pose` からマスク形状・ポーズ画像を表示する。配信側は保存済みパスがデータディレクトリ配下にある場合だけ stream する。
- `patchControlNetPath` は `ControlNetApplyAdvanced` ノードを `roleMap.controlnet_apply_node`(無ければクラス名検索)で特定し、その `inputs.image` の**接続を辿って**供給元 LoadImage ノードを見つける(class 検索ではなく connection トレース)。辿り着いた LoadImage が親画像用として使われている場合は上書きせず新規 LoadImage を追加する。ControlNet 非対応テンプレートでは何もせず optional に振る舞う。
- **img2img / inpaint と pose 添付は併用できる**(2026-07-03 対応済み、`Docs/Done/Feature-PoseControlNet-Img2Img.md`)。かつて禁止していた原因(`inferRoleMap` の `vae_encode_image_input` 誤推論でワークフローが壊れる)は根本修正され、保存済みテンプレートも生成時の `sanitizeRoleMap` で防御されるため再登録不要。pose 未添付の img2img では ControlNet strength を 0 にして no-op 化する。
- グリッドの `POSE` バッジ(`.pose-badge`)は MASK バッジと全く同じセマンティクスで、ポーズデータ(`hasPoseData`)があれば `enabled` に関わらず常に表示し、クリックで `PoseDraft.enabled` を直接トグルする。ON の間だけグリッドに静的なスケルトンプレビュー(`.pose-grid-overlay`、当たり判定なしの `<svg>`。関節ドラッグ等の編集用 `renderPoseOverlay` とは別の軽量な描画関数 `renderPoseGridOverlay`)を重ねる。

## 添付トグル UI(マスク/ポーズ共通)

- マスク・ポーズタブの「次回生成に添付」チェックは `.tab-attach-lamp`(10px 正方形のランプボタン)で表示する。未生成(マスクなし/ポーズ未検出)=灰色・クリック不可、生成済み+添付ON=緑「on」、生成済み+添付OFF=暗赤「off」で、緑⇄赤のみクリックでトグルする。
- 3状態は白黒化しても判別できる明度差(約 45%/75%/22%)を持たせている。添付ONでもデータが空なら inpaint/controlnet リクエストは組まれないため生成に影響しない。
- マスクの最初のストローク確定時に再描画してスイッチを即時 off(赤)へ更新する。
- action は `toggle-mask-attach` / `toggle-pose-attach` を registry 経由で共有し、`.tab-attach-lamp` はモーダルを開いている asset(`state.activeAssetId`)を暗黙の対象にする(`toggleMaskAttach` / `togglePoseAttach()` 引数省略)。

### グリッドカードの MASK / POSE バッジ

- 画像グリッドの各カードには、マスク/ポーズデータがある(≠添付ONである)アセットにだけ `MASK`(`.mask-badge`)/ `POSE`(`.pose-badge`)バッジを表示する。バッジは常に `data-id="<assetId>"` 付きの `toggle-mask-attach` / `toggle-pose-attach` action で、モーダルを開かずにその場で `InpaintDraft.enabled` / `PoseDraft.enabled` を直接トグルする(`toggleMaskAttachForAsset` / `togglePoseAttach(assetId)`、いずれも `.tab-attach-lamp` と同じ draft フィールドを共有するため、モーダルとグリッドのどちらで ON/OFF してももう一方に反映される)。
- バッジの見た目(`active`/`inactive` class)は `enabled` の値をそのまま反映する。データの有無ではなく添付 ON/OFF だけを表す点は `.tab-attach-lamp` の 緑/暗赤 と同じ意味だが、グリッドでは 2 状態(データなし=バッジ非表示、あり=常時表示 + active/inactive)。
- `enabled` が true の間だけ、カード画像の上にプレビューを重ねる: マスクは `.mask-grid-preview`(`<img src="maskDataUrl">`、`.mask-canvas` と同じ opacity 0.58)、ポーズは `.pose-grid-overlay`(静的スケルトン SVG、`renderPoseGridOverlay`)。貼り付け(`PASTE`、`.paste-badge`/`.paste-grid-canvas`、詳細は `Docs/Done/Feature-ImagePaste.md`)も同じ「データがあれば常時バッジ表示 + per-asset enabled トグル」方式に揃えてあり、3つを重ねたときのレイヤ順は **MASK(最下)→ PASTE → POSE(最上)** に固定(`round-grid.css` の `z-index: 1/2/3`、DOM 順もこの順)。
- かつて存在した表示 ON/OFF 専用のグローバルフラグ(`showMaskGridTag` / `showPoseGridTag` / `showPasteGridTag`)は、この per-asset `enabled` 方式に統合されて廃止済み(2026-07-06)。
