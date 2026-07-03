# 新機能実装 進捗・再開メモ

- 最終更新: 2026-07-03（PoseControlNet フェーズ4 完了・マージ済み）
- **ユーザー指示: 以降のポーズ（PoseControlNet）関連の作業はサブエージェントに委譲せず、Fable 5（メインセッション）が直接実装すること**
- 方式: ブランチ + サブエージェント監督方式（サブエージェントは sonnet、worktree 分離）。設計仕様は `Docs/Feature-*.md` / `Docs/Fix-*.md`

## 完了済み（main にマージ済み）

| 項目 | 状態 |
| --- | --- |
| GitHub Release `pose-models-v1` | 作成済み。asset `pose_landmarker_full.task`（9,398,198 bytes）アップロード・検証済み |
| Feature-IterationTreeHue | ✅ マージ済み `c2a8fd8`（`rootHue`/`childHue` + テスト12件） |
| PoseControlNet フェーズ1（モデル配布 proxy） | ✅ マージ済み `9bf5eff`（`releaseAssetRegistry` 一般化 + `GET /api/pose-models/:filename`。curl 確認済み） |
| Feature-MaskFeather | ✅ マージ済み `1631a2e`（`addMaskFeatherNodes`＝MaskToImage→ImageBlur→ImageToMask、featherRadius 0–30 のクライアント経路 + スライダー2箇所。マージ後 main で typecheck 0 / 211 pass / check 成功。クライアント側 blur プレビューは第2フェーズとして未実装） |

マージ後の main で `npm run typecheck` 0 エラー / `npm test` 199 pass / build / check すべて成功確認済み。

## 第1波の中断分 — 2026-07-03 に完了

| 項目 | 状態 |
| --- | --- |
| Fix-MaskPenLag | ✅ マージ済み `190e50e`（A: pointerdown コミット除去 / B・C: rAF バッチ + dirtyRect 限定合成 / D: ホイールズームは `--mask-zoom` 直接更新 + 150ms idle で draft 永続化 / E: カーソル要素キャッシュ — null 判定バグ修正込み） |
| Feature-MaskFeather | ✅ マージ済み `1631a2e`（上表参照） |

- マージは feather → pen-lag の順で実施。`main.ts` / `maskTypes.ts` は自動マージで衝突なし
- マージ後 main: typecheck 0 エラー / **222 pass** / build / check 成功
- マージ後ブラウザ smoke 済み（preview 1680x920、テスト DB、port 5599）: feather スライダー 0→12px 反映・再レンダー後も保持、ペンストローク（dab + pointermove×15 + up）描画成功、ホイールズームで `--mask-zoom` 1→1.12→1.24 即時更新・idle 後も保持、コンソールエラー / 失敗リクエストなし
- 注意: smoke 用フィクスチャ画像は 1x1 プレースホルダ。合成 PointerEvent では `setPointerCapture` が NotFoundError を投げるため、eval からの smoke 時はスタブが必要（実ポインタでは問題なし）
- 両 worktree（`agent-a36e377ab17013e36` / `agent-a20d1f6f42bd4c92d`）は削除してよい

## PoseControlNet フェーズ4 — 2026-07-03 完了・マージ済み

- ブランチ `feature/pose-4-edit`（worktree `.claude/worktrees/pose-4-edit`、main の `bbac81f` ベース）で Fable 5 が直接再開・完走。マージ後 worktree・ブランチとも削除済み
- 引き継ぎ時点の未コミット diff（`poseDraft.ts` 含む）を全レビュー → 問題なしと判断（`nearestPoseJointIndex` ヘルパーは妥当な純粋関数）
- コミット `43f37e9` "Add pose joint drag/click editing" として確定:
  - `maskCanvas.ts`: `pointerToSvgViewBoxPoint(svg, event)`
  - `views/posePanel.ts`: `.pose-bone` に `data-bone-index`/`data-bone-from`/`data-bone-to`
  - `styles.css`: `.pose-joint { pointer-events:all; cursor:grab; touch-action:none }` + `.pose-joint.dragging`
  - `main.ts`: `ActivePoseJointDrag` + pointerdown/move/up 分岐（`state.maskEditMode && state.maskPanelTab==="pose"` でゲート）。ドラッグ中は `render()` を呼ばず SVG 属性を直接更新、pointerup で `PoseDraft.points` へコミット（移動なしはクリック＝visible トグル、移動ありは座標確定・`clampPointToPoseBounds` で画像範囲にクランプ）。いずれも `source:"edited"`
- ブラウザ実機検証（テスト DB、ポート3000、`.claude/launch.json` に一時追加した `guruguru-pose4-edit` 設定は検証後削除）:
  - MediaPipe は極小テスト画像（64x96 の棒人間シルエット）を人物として検出できなかったため、`window.__poseDebug`（`state`/`setPoseDraft`/`render` を露出する一時デバッグフック）を `main.ts` に追加し、合成した18関節の `PoseDraft.points` を直接注入して検証。**検証完了後にフックは削除済み**（コミット済みコードには含まれない）
  - 確認内容: オーバーレイが18関節/17ボーンを正しく描画 / クリック（移動なし pointerdown→pointerup）で `visible` トグル・`source:"edited"` / ドラッグ（pointerdown→pointermove→pointerup）で関節と接続ボーンの端点がライブ更新され pointerup で座標確定 / 画像範囲外へのドラッグは `[0,width]×[0,height]` にクランプ / pose タブ表示中は `#maskCanvas` が `pointer-events:none` でマスクブラシ/SAM等と非干渉
- マージ後 main: typecheck 0 / **249 pass** / build / check すべて成功確認済み（衝突なしのクリーンマージ）

## その後の残タスク（未着手）

1. **Feature-PaintTool** — ✅ マージ済み `7f0d864`（フェーズ1〜5: PaintDraft / brush・eraser・eyedropper / パレット + recent colors / rAF バッチ描画（mask と同一パス、`paintStroke` に color 引数追加）/ Undo リング5 / Alt 一時スポイト / Ctrl+Z / 保存は既存 source-assets API で新規 root round。フェーズ6（ツリー親子リンク）は設計上任意のため未実装）。マージ時に `a5c0b9c` と `main.ts` / `assetModal.ts` で衝突 → `renderAssetModal` へ `maskPanelWidths` と `paintEditing`/`paintDraft` を両立させて手動統合。マージ後 main: typecheck 0 / 228 pass / check 成功。ブラウザ smoke 済み（paint パネル UI、赤ストローク描画 → Undo で消去 → 再描画 → 保存で新 round/asset 生成・保存画像に 1600x1200 で合成確認、mask/paint 相互排他、mask 側の feather スライダー・invert・リサイザも健在、コンソールエラー / 失敗リクエストなし）
2. **Feature-PoseControlNet フェーズ 5〜6** — ✅ 完了（下記変更履歴参照）。これで PoseControlNet 機能（フェーズ1〜6）はすべて完了。
3. 最終検証 + `操作メモ.md` 追記 — ✅ 完了（下記変更履歴参照）。本ファイルと各設計ドキュメントは本コミットで `Docs/Done/` へ移動する。

## 変更履歴

- 2026-07-02: 初版。第1波の途中経過（2件マージ済み・2件中断）を記録。
- 2026-07-03: 作業再開。Feature-MaskFeather 完了・マージ（`1631a2e`）、Fix-MaskPenLag 完了・マージ（`190e50e`）。マージ後検証 + ブラウザ smoke 完了。第1波クローズ。
- 2026-07-03: 第2波開始。PoseControlNet フェーズ2 完了・マージ（`2fec090`、マージ後 main で typecheck 0 / 222 pass / check 成功）。なお main に手動コミット `a5c0b9c`（Mask editor UX fixes）が第2波ブランチ分岐後に入っていた。
- 2026-07-03: Feature-PaintTool 完了・マージ（`7f0d864`、衝突2ファイル手動統合）。マージ後検証 + ブラウザ smoke 完了。第2波クローズ。残タスクは PoseControlNet フェーズ3〜6 と最終検証・ドキュメント整理のみ。
  - 補足: `.claude/launch.json` は別チャットの dev サーバとポート競合したため `autoPort: true` + セッション別データディレクトリ方式へ変更。
- 2026-07-03: PoseControlNet フェーズ4 着手、途中で使用量制限により中断（上記「中断中」節参照）。担当エージェントが無断で孫エージェントへ再委譲する問題があり（成果自体は孫が実装）、以降のポーズ作業はエージェント委譲禁止・Fable 5 直接実装とする（ユーザー指示）。
- 2026-07-03: PoseControlNet フェーズ3 完了・マージ（`b3fcd62`）。pose タブ UI（マスク/ポーズタブ、`posePanel.ts`、SVG スケルトンオーバーレイ、MediaPipe33→OpenPose18 変換 `poseDraft.ts` + テスト11件）。担当エージェントが実人物写真で 18 関節・17 bone の検出&オーバーレイ整合を実機確認済み。マージ後 main: typecheck 0 / **239 pass** / check 成功、タブ切替・相互排他（pose 中 maskCanvas pointer-events:none）の smoke 済み。途中セッション使用量制限で中断→同エージェントを transcript から再開して完走。次はフェーズ4（関節ドラッグ編集 + スケルトン PNG）。
- 2026-07-03: PoseControlNet フェーズ4 完了・マージ（`43f37e9`）。Fable 5 が直接実装・検証（サブエージェント不使用、ユーザー指示どおり）。関節ドラッグ編集＋クリックで visible トグル。MediaPipe が極小テスト画像を検出できなかったため、一時デバッグフックで合成ポーズ点を注入してブラウザ実機検証（検証後フックは削除）。マージ後 main: typecheck 0 / **249 pass** / check 成功。worktree・ブランチとも削除済み。残りはフェーズ5（サーバ添付パイプライン）・6（棒人間バッジ）のみ。
- 2026-07-03: PoseControlNet フェーズ5〜6 完了・マージ。メインセッション（サブエージェント不使用、ユーザー指示どおり）がブランチ `feature/pose-5-server-pipeline` で直接実装。フェーズ5: `ControlNetOptions` 型・`workflowControlNet.ts`（`patchControlNetPath`、`ControlNetApplyAdvanced.inputs.image` の connection トレース方式）・`rounds.ts` の `prepareControlNetRequest`（`storeControlImage`/`decodeControlImageDataUrl`、`request_json` 保存前 `poseImageDataUrl` null 化）・`workflowRoleMap.ts` の `controlnet_apply_node` 等推論・`workflow.test.ts` への characterization test 4件（`load_image_input` 誤推論との衝突で pose が勝つケース含む）を先行実装。フェーズ6: client `controlnetRequestForParent`（テンプレート capability 判定）・`iconPose`・`.pose-badge`・`galleryView.ts` の `getPoseDraft` 配線。マージ後 main: typecheck 0 / **253 pass** / build / check 成功。ブラウザ smoke（test DB、port 3000）: pose タブ・スケルトンオーバーレイ・pose パネルが既存機能と相互排他したまま正常表示、console/server error なし。PoseControlNet 機能（フェーズ1〜6）完了。`操作メモ.md` に「ポーズ ControlNet 添付」節を追記。
