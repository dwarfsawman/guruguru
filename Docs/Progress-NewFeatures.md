# 新機能実装 進捗・再開メモ

- 最終更新: 2026-07-03（第1波完了。MaskFeather / MaskPenLag ともマージ済み・マージ後 smoke 済み）
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

## その後の残タスク（未着手）

1. **Feature-PaintTool**（`Docs/Feature-PaintTool.md`）— Fix-MaskPenLag マージ済みのため着手可能。ブランチ `feature/paint-tool`
2. **Feature-PoseControlNet フェーズ 2〜6**（`Docs/Feature-PoseControlNet.md` の実装フェーズ節参照）— フェーズ1は完了済み。次はフェーズ2（`@mediapipe/tasks-vision` 導入 + pose worker + build.mjs の wasm コピー + OPFS）。以降 3（タブ UI + 検出）→ 4（関節ドラッグ編集 + スケルトン PNG）→ 5（サーバ添付パイプライン、**characterization test 先行**）→ 6（棒人間バッジ）
3. 最終検証 + `操作メモ.md` 追記 + 完了ドキュメントの実施記録追記（完了後に本ファイルと各設計ドキュメントを `Docs/Done/` へ移す）

## 変更履歴

- 2026-07-02: 初版。第1波の途中経過（2件マージ済み・2件中断）を記録。
- 2026-07-03: 作業再開。Feature-MaskFeather 完了・マージ（`1631a2e`）、Fix-MaskPenLag 完了・マージ（`190e50e`）。マージ後検証 + ブラウザ smoke 完了。第1波クローズ。次は Feature-PaintTool と PoseControlNet フェーズ2。
