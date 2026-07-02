# 新機能実装 進捗・再開メモ

- 最終更新: 2026-07-02（使用量上限のため中断。ここから再開する）
- 方式: ブランチ + サブエージェント監督方式（サブエージェントは sonnet、worktree 分離）。設計仕様は `Docs/Feature-*.md` / `Docs/Fix-*.md`

## 完了済み（main にマージ済み）

| 項目 | 状態 |
| --- | --- |
| GitHub Release `pose-models-v1` | 作成済み。asset `pose_landmarker_full.task`（9,398,198 bytes）アップロード・検証済み |
| Feature-IterationTreeHue | ✅ マージ済み `c2a8fd8`（`rootHue`/`childHue` + テスト12件） |
| PoseControlNet フェーズ1（モデル配布 proxy） | ✅ マージ済み `9bf5eff`（`releaseAssetRegistry` 一般化 + `GET /api/pose-models/:filename`。curl 確認済み） |

マージ後の main で `npm run typecheck` 0 エラー / `npm test` 199 pass / build / check すべて成功確認済み。

## 中断中（worktree に作業状態が残っている）

### 1. Fix-MaskPenLag（ブランチ `fix/mask-pen-lag`）

- worktree: `.claude/worktrees/agent-a36e377ab17013e36`
- コミット済み: `ea42837` "Add rAF batch queue types and dirtyRect compositing pure helpers to maskCanvas.ts"
- 未コミット: `src/client/main.ts` 変更中（rAF バッチ配線 + カーソルキャッシュ実装の途中）
- 中断時の状況: 修正 E（カーソル要素キャッシュ）で `cachedMaskBrushCursor` の null 判定ロジック（`A || B` の短絡で null に `.isConnected` アクセスし得る）を直そうとしていた
- 残作業: B/C の main.ts 配線仕上げ、A（pointerdown コミット除去）、D（ホイールズーム軽量化 — CSS 変数は `.preview-media` へ setProperty）、E の null 判定修正、検証一式

### 2. Feature-MaskFeather（ブランチ `feature/mask-feather`）

- worktree: `.claude/worktrees/agent-a20d1f6f42bd4c92d`
- コミット済み: `201d515` "Add characterization tests for inpaint normalization + featherRadius=0 no-op"
- 未コミット: `src/server/rounds.ts` / `workflowInpaint.ts` / `shared/types.ts` / `rounds.test.ts` 変更中（`addMaskFeatherNodes` 実装 + feather ありのテスト作成途中。ノード採番のトレースまで進行）
- 残作業: feather テスト完成、クライアント側パラメータ経路（`InpaintDraft.featherRadius` / UI スライダー2箇所 / `updateInpaintDraftFromControl` 分岐 / **`inpaintRequestForParent` の返却 object への追加**）、検証一式

## 再開手順

1. `git worktree list` で上記 2 worktree が残っていることを確認
2. 各 worktree ごとに新しいサブエージェント（sonnet）を起動し、「該当ブランチの worktree で作業続行。まず `git status` / `git log` / 未コミット diff を確認し、設計ドキュメント（`Docs/Fix-MaskPenLag.md` / `Docs/Feature-MaskFeather.md`）の残項目を実装せよ」と指示する（前回の指示内容は各設計ドキュメントの「厳守事項」節と同じ: テスト DB・非 5177・検証コマンド一式・意味単位コミット・push 禁止）
3. 完了したら監督者が diff レビュー → typecheck/test/build/check → main へ `--no-ff` マージ（2 本とも mask 系で `main.ts` を触るため、後からマージする方に衝突の可能性あり — 手動統合）
4. マージ後にブラウザ smoke（preview、1680x920、`GURUGURU_TEST_DB=1`、非 5177 ポート）

## その後の残タスク（未着手）

1. **Feature-PaintTool**（`Docs/Feature-PaintTool.md`）— Fix-MaskPenLag マージ後に着手（同じ描画パスを使うため）。ブランチ `feature/paint-tool`
2. **Feature-PoseControlNet フェーズ 2〜6**（`Docs/Feature-PoseControlNet.md` の実装フェーズ節参照）— フェーズ1は完了済み。次はフェーズ2（`@mediapipe/tasks-vision` 導入 + pose worker + build.mjs の wasm コピー + OPFS）。以降 3（タブ UI + 検出）→ 4（関節ドラッグ編集 + スケルトン PNG）→ 5（サーバ添付パイプライン、**characterization test 先行**）→ 6（棒人間バッジ）
3. 最終検証 + `操作メモ.md` 追記 + 完了ドキュメントの実施記録追記（完了後に本ファイルと各設計ドキュメントを `Docs/Done/` へ移す）

## 変更履歴

- 2026-07-02: 初版。第1波の途中経過（2件マージ済み・2件中断）を記録。
