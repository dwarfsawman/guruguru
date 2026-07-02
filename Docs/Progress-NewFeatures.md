# 新機能実装 進捗・再開メモ

- 最終更新: 2026-07-03（使用量制限のため中断。PoseControlNet フェーズ4の途中 — 下記「中断中」参照）
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

## 中断中（2026-07-03、使用量制限）: PoseControlNet フェーズ4（ブランチ `feature/pose-4-edit`）

- worktree: `.claude/worktrees/pose-4-edit`（main の `bbac81f` ベース、npm ci 済み）
- コミット済み: `55561d4` "Add pure OpenPose skeleton PNG draw-ops + renderer" — `src/client/poseSkeleton.ts`（`buildPoseSkeletonDrawOps` / `poseSkeletonLineWidth` / `renderPoseSkeletonDataUrl`）+ `poseSkeleton.test.ts`（10件）。まだ呼び出し元なし（フェーズ5用、意図どおり）
- 未コミット変更（関節ドラッグ + クリックで visible トグル。実装は一貫、typecheck/test 249 pass/build/check 通過済みだが**実ブラウザ検証が未実施**）:
  - `maskCanvas.ts`: `pointerToSvgViewBoxPoint(svg, event)` 追加
  - `views/posePanel.ts`: `<line class="pose-bone">` に `data-bone-index`/`data-bone-from`/`data-bone-to` 付与
  - `styles.css`: `.pose-joint { pointer-events:all; cursor:grab; touch-action:none }` + `.pose-joint.dragging`
  - `main.ts`: `ActivePoseJointDrag` + pointerdown 分岐（`state.maskEditMode && state.maskPanelTab === "pose"` でゲート）+ `beginPoseJointDrag` / `continuePoseJointDrag` / `clampPointToPoseBounds` / `finishPoseJointDrag`（ドラッグで座標確定、クリックで visible トグル、いずれも `source:"edited"` → `render()`）
  - `poseDraft.ts`: 引き継ぎエージェントが停止直前に触った可能性あり — 再開時に diff を要確認
- 残作業: ①未コミット diff の全レビュー（特に `poseDraft.ts`）②実ブラウザでのドラッグ/クリック検証（関節ドラッグで座標更新・オーバーレイと `PoseDraft.points` の整合、クリックで visible トグル、マスクブラシ/SAM box prompt/ペイントと非干渉。テスト DB・非 5177/5599 ポート）③検証一式再実行 ④意味単位コミット ⑤マージ（監督フロー）
- **再開時は上記ユーザー指示によりサブエージェントを使わず Fable 5 が直接この worktree で作業すること**

## その後の残タスク（未着手）

1. **Feature-PaintTool** — ✅ マージ済み `7f0d864`（フェーズ1〜5: PaintDraft / brush・eraser・eyedropper / パレット + recent colors / rAF バッチ描画（mask と同一パス、`paintStroke` に color 引数追加）/ Undo リング5 / Alt 一時スポイト / Ctrl+Z / 保存は既存 source-assets API で新規 root round。フェーズ6（ツリー親子リンク）は設計上任意のため未実装）。マージ時に `a5c0b9c` と `main.ts` / `assetModal.ts` で衝突 → `renderAssetModal` へ `maskPanelWidths` と `paintEditing`/`paintDraft` を両立させて手動統合。マージ後 main: typecheck 0 / 228 pass / check 成功。ブラウザ smoke 済み（paint パネル UI、赤ストローク描画 → Undo で消去 → 再描画 → 保存で新 round/asset 生成・保存画像に 1600x1200 で合成確認、mask/paint 相互排他、mask 側の feather スライダー・invert・リサイザも健在、コンソールエラー / 失敗リクエストなし）
2. **Feature-PoseControlNet フェーズ 4〜6**（`Docs/Feature-PoseControlNet.md` の実装フェーズ節参照）— フェーズ2は ✅ マージ済み `2fec090`（`@mediapipe/tasks-vision@0.10.35` + `src/client/pose/`（types/models/worker）+ build.mjs の worker バンドル & wasm コピー + OPFS キャッシュ。ブラウザ実機で DL→OPFS→model-ready(GPU)→detect まで確認済み）。**重要な知見: MediaPipe の wasm グルーは module worker 非対応のため pose-worker は IIFE + クラシック worker（`{type:"module"}` を付けない）で起動すること**。`main.ts` への worker 統合はフェーズ3（タブ UI + 検出）の範囲。以降 4（関節ドラッグ編集 + スケルトン PNG）→ 5（サーバ添付パイプライン、**characterization test 先行**）→ 6（棒人間バッジ）
3. 最終検証 + `操作メモ.md` 追記 + 完了ドキュメントの実施記録追記（完了後に本ファイルと各設計ドキュメントを `Docs/Done/` へ移す）

## 変更履歴

- 2026-07-02: 初版。第1波の途中経過（2件マージ済み・2件中断）を記録。
- 2026-07-03: 作業再開。Feature-MaskFeather 完了・マージ（`1631a2e`）、Fix-MaskPenLag 完了・マージ（`190e50e`）。マージ後検証 + ブラウザ smoke 完了。第1波クローズ。
- 2026-07-03: 第2波開始。PoseControlNet フェーズ2 完了・マージ（`2fec090`、マージ後 main で typecheck 0 / 222 pass / check 成功）。なお main に手動コミット `a5c0b9c`（Mask editor UX fixes）が第2波ブランチ分岐後に入っていた。
- 2026-07-03: Feature-PaintTool 完了・マージ（`7f0d864`、衝突2ファイル手動統合）。マージ後検証 + ブラウザ smoke 完了。第2波クローズ。残タスクは PoseControlNet フェーズ3〜6 と最終検証・ドキュメント整理のみ。
  - 補足: `.claude/launch.json` は別チャットの dev サーバとポート競合したため `autoPort: true` + セッション別データディレクトリ方式へ変更。
- 2026-07-03: PoseControlNet フェーズ4 着手、途中で使用量制限により中断（上記「中断中」節参照）。担当エージェントが無断で孫エージェントへ再委譲する問題があり（成果自体は孫が実装）、以降のポーズ作業はエージェント委譲禁止・Fable 5 直接実装とする（ユーザー指示）。
- 2026-07-03: PoseControlNet フェーズ3 完了・マージ（`b3fcd62`）。pose タブ UI（マスク/ポーズタブ、`posePanel.ts`、SVG スケルトンオーバーレイ、MediaPipe33→OpenPose18 変換 `poseDraft.ts` + テスト11件）。担当エージェントが実人物写真で 18 関節・17 bone の検出&オーバーレイ整合を実機確認済み。マージ後 main: typecheck 0 / **239 pass** / check 成功、タブ切替・相互排他（pose 中 maskCanvas pointer-events:none）の smoke 済み。途中セッション使用量制限で中断→同エージェントを transcript から再開して完走。次はフェーズ4（関節ドラッグ編集 + スケルトン PNG）。
