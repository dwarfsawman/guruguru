# マスク・ポーズ添付パイプライン リファレンス

生成時に「元画像+add-on」を ComfyUI へ渡す添付パイプライン(マスク編集/inpaint と ポーズ ControlNet 添付)の内部実装メモ。運用手順・落とし穴の一覧は `操作メモ.md`、機能ごとの設計経緯は `Docs/Done/` を参照。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## マスク・inpaint

- 通常の img2img は、親画像を指定した幅・高さへ `ImageScale` でリサイズしてから `VAEEncode` に渡す。フォームの幅・高さは EmptyLatent ではなく、このリサイズノードで実際の出力サイズに反映される。
- マスク付き inpaint は、保存時のマスク寸法が親画像と一致していることを検証したうえで、生成時に親画像とマスクを同じ指定幅・高さへリサイズしてから `VAEEncode` / 合成へ渡す。
- 画像詳細ビューアのマスク編集は、親画像と同じサイズの PNG マスクだけを生成リクエストに使う。
- GURUGURU が生成するマスク PNG は透明背景に白で描画する。ComfyUI の `LoadImageMask` は alpha を反転マスクとして読むため、workflow patch では `red` チャンネルを使い、白い描画部分を更新対象にする。
- スマート選択で WebSAM / SlimSAM-77 を使う場合、既定ではローカルAPI `/api/websam-models` 経由で GitHub Release `websam-models-v1` の `slimsam-77-encoder.onnx` と `slimsam-77-decoder.onnx` を取得する。別の配布先を使う場合だけ、設定画面の `WebSAM model base URL` を変更する。
- このリポジトリは private のため、既定の `/api/websam-models` で release asset を読むには GURUGURU サーバー起動時に `GURUGURU_GITHUB_TOKEN`、`GH_TOKEN`、または `GITHUB_TOKEN` を設定する。token はブラウザへ渡さず、サーバー側で GitHub Release API を呼ぶためだけに使う。
- サーバーの release asset proxy(`src/server/index.ts` の `serveReleaseAsset`)は「ファイル名 → release API URL」のレジストリ方式。WebSAM 用(`slimsam-77-encoder.onnx` / `slimsam-77-decoder.onnx` → `websam-models-v1`)に加え、ポーズ検出モデル用(`pose_landmarker_full.task` → GitHub Release `pose-models-v1`、`GET /api/pose-models/:filename`)を同じハンドラで配信する。token 要件・404/503 の挙動・streaming・cache-control は用途間で共通。
- SlimSAM-77 のモデルファイルはブラウザの OPFS にキャッシュされる。2回目以降はキャッシュ済みファイルを優先する。OPFS非対応ブラウザでは手動マスク機能はそのまま使えるが、WebSAMのキャッシュは使えない。
- スマート選択の最終マスクは `finalMask = (samMask OR manualIncludeMask) AND NOT manualEraseMask` として合成し、この白黒PNGだけを `maskDataUrl` として送る。SAM候補プレビューは「適用」するまで `samMask` として確定しない。
- 手動ペン(`manual-include`)で描くときは `manualInclude` レイヤーに加えて同じストローク形状を `manualErase` レイヤーから `destination-out` で削除する。これにより「消しゴムで消した領域を後からペンで再描きして復活させる」ことができる。消しゴムは引き続き `manualErase` に追加し、SAM結果や手動追加を最終合成で抜く。
- WebSAM Brush prompt のサンプリング間隔は `BRUSH_PROMPT_POINT_SPACING`(48px)/ `BRUSH_PROMPT_MAX_POINTS`(48点)で間引く。マジックナンバーではなく定数化し、過剰な点で decode が重くなるのを防ぐ。消しゴムによる点削除(`removeBrushPromptPointsNearSegment`)はブラシ半径ベースなので間引いた後も整合する。
- マスク編集時はブラシサイズ相当の半透明円(`.brush-cursor`)を画像座標系で追従表示する。ペン=緑、消しゴム=赤、Brush prompt=青。Point/Box モードでは非表示。ズーム・パンでも画像座標とズレない(SVG overlay が `mask-zoom-stage` 内で一緒にスケールする)。
- inpaint の `maskedContent` 既定は `original`(元画像の潜在を維持 + `SetLatentNoiseMask`)。`fill`(`VAEEncodeForInpaint` でマスク部をゼロ埋め)は低デノイズで灰色ベタが残りやすいため既定から外した。UIの選択肢ラベルで灰色化の有無を明示している。
- `patchInpaintLatentPath` では、サンプラー用ノイズマスク(`GrowMask` 済み・padding 含む)と、最終 paste back 用 `ImageCompositeMasked` のマスク(元の非拡大マスク)を分離する。これにより padding 領域へ生成結果が意図より広く貼り戻されるのを防ぎ、灰色化を悪化させない。
- デノイズ強度はラウンド切替や親画像切替でも保持する。`selectRound` はフォーム全体を破棄せず `denoise` だけ引き継ぐ。`fillGenerationFormFromAsset` は既存の denoise を上書きしない(txt2img など `requiresFullDenoise` のモードを除く)。`renderGenerationPanel` の表示値は `normalizeDenoiseForMode` で正規化し、実際に送信される `request.denoise` と一致させる。
- `generation_rounds.request_json` には `maskedContent`、`inpaintArea`、`onlyMaskedPadding` と保存済みマスク参照だけを残し、巨大な `maskDataUrl` は保存しない。
- マスク画像は各 Project の外部データディレクトリ配下 `projects/<projectId>/masks/` に保存される。
- 画像カードの `MASK` 表示は、次回の img2img ブランチング request にマスクが実際に入る状態だけに付ける。マスク付き生成から生まれた画像でも、その画像自身に有効なマスク下書きがなければ通常画像として扱う。
- マスク編集を OFF にした場合、描いたマスク画像は下書きとして残しても request には含めず、`MASK` 表示も外す。再度 ON にすると残っている下書きを編集・適用できる。

## ポーズ ControlNet 添付

- 画像詳細ビューアのマスク編集サイドバーに「マスク / ポーズ」タブがあり、ポーズタブでは検出モデル(MediaPipe Pose Landmarker Full / Heavy、CIGPose)で検出した OpenPose 18点を関節ドラッグ・エッジ選択・マーキーで編集できる(複数人最大4人・Undo・Shift ドラッグの骨長固定 FK 対応)。編集対象は常に OpenPose 18点(MediaPipe 33 landmarks は検出直後に変換して破棄)。モデルは GitHub Release から `/api/pose-models` 経由で取得し OPFS にキャッシュする。
- ポーズタブの添付チェックを ON にした状態で生成すると、`renderPoseSkeletonDataUrl` が黒背景 + OpenPose 標準配色のスケルトン PNG を描画し、`request.controlnet.poseImageDataUrl` として送信する。**送信先テンプレートの workflowJson に `ControlNetApplyAdvanced` ノードが無い場合は添付自体を行わない**(クライアント側 capability チェック、`workflowHasControlNetApply`)。
- サーバーはマスクと同型の添付パイプラインで処理する: `decodeControlImageDataUrl`(PNG限定・8MB上限)→ `storeControlImage`(`projects/<projectId>/control/<roundId>_pose.png`)→ `uploadImageToComfy` → `patchControlNetPath`。`request_json` へ保存する前に `poseImageDataUrl` は null 化し、巨大 dataURL を DB に残さない(マスクの `maskDataUrl` null 化と同じ規約)。
- `patchControlNetPath` は `ControlNetApplyAdvanced` ノードを `roleMap.controlnet_apply_node`(無ければクラス名検索)で特定し、その `inputs.image` の**接続を辿って**供給元 LoadImage ノードを見つける(class 検索ではなく connection トレース)。辿り着いた LoadImage が親画像用として使われている場合は上書きせず新規 LoadImage を追加する。ControlNet 非対応テンプレートでは何もせず optional に振る舞う。
- **img2img / inpaint と pose 添付は併用できる**(2026-07-03 対応済み、`Docs/Done/Feature-PoseControlNet-Img2Img.md`)。かつて禁止していた原因(`inferRoleMap` の `vae_encode_image_input` 誤推論でワークフローが壊れる)は根本修正され、保存済みテンプレートも生成時の `sanitizeRoleMap` で防御されるため再登録不要。pose 未添付の img2img では ControlNet strength を 0 にして no-op 化する。
- グリッドの `POSE` バッジ(紫、`.pose-badge`)は MASK バッジと同じ「次回生成に添付される」draft 駆動のセマンティクスだが、表示 ON/OFF トグルは `showPoseGridTag`(`toggle-pose-grid-tag`)として MASK バッジの `showMaskGridTag`(`toggle-mask-grid-tag`)とは独立している(以前は同じ `showMaskGridTag` に相乗りしており連動して切り替わってしまっていた)。

## 添付トグル UI(マスク/ポーズ共通)

- マスク・ポーズタブの「次回生成に添付」チェックは `.tab-attach-lamp`(10px 正方形のランプボタン)で表示する。未生成(マスクなし/ポーズ未検出)=灰色・クリック不可、生成済み+添付ON=緑「on」、生成済み+添付OFF=暗赤「off」で、緑⇄赤のみクリックでトグルする。
- 3状態は白黒化しても判別できる明度差(約 45%/75%/22%)を持たせている。添付ONでもデータが空なら inpaint/controlnet リクエストは組まれないため生成に影響しない。
- マスクの最初のストローク確定時に再描画してスイッチを即時 off(赤)へ更新する。
