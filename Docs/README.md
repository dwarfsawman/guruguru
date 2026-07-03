# Docs フォルダ

GURUGURU の設計ドキュメント・参照資料の置き場。運用手順・落とし穴は従来どおりリポジトリ直下の `操作メモ.md` に集約する（AGENTS.md の規約）。

## 構成

- `Docs/` 直下 — 進行中の機能設計ドキュメント（現在なし。次の新機能起票時にここへ追加する）
- `Docs/Done/` — 完了した作業ログ・設計ドキュメント
- `Docs/ReferenceFlows/` — 参照用 ComfyUI ワークフロー JSON（API フォーマット）
  - [Reference-UnifiedSwitchWorkflow.json](ReferenceFlows/Reference-UnifiedSwitchWorkflow.json) — txt2img / img2img / inpaint / ControlNet有無 を switch + PrimitiveBoolean で1本化した統合ワークフロー。解説は [Reference-UnifiedSwitchWorkflow.md](ReferenceFlows/Reference-UnifiedSwitchWorkflow.md)

## 完了した設計ドキュメント（2026-07-02 起票 → 2026-07-03 全件完了）

| ドキュメント | 内容 | 規模感 |
| --- | --- | --- |
| [Feature-PoseControlNet.md](Done/Feature-PoseControlNet.md) | MediaPipe Pose Landmarker による人物ポーズ検出 + 関節編集 + ControlNet 添付生成。タブ UI・棒人間バッジ含む | 大 |
| [Feature-MaskFeather.md](Done/Feature-MaskFeather.md) | inpaint マスクの blur / feather（境界ぼかし） | 小〜中 |
| [Feature-PaintTool.md](Done/Feature-PaintTool.md) | 画像ペイントツール（基本色 + 任意カラー + スポイト、新規アセット保存） | 中 |
| [Fix-MaskPenLag.md](Done/Fix-MaskPenLag.md) | マスクペンのかくつき修正（HW アクセラレーション無効環境） | 小〜中 |
| [Feature-IterationTreeHue.md](Done/Feature-IterationTreeHue.md) | イテレーションツリー配色の改善（色相進行の抑制 + denoise 連動） | 小 |

進捗の詳細は [Done/Progress-NewFeatures.md](Done/Progress-NewFeatures.md) を参照。

## 運用

- 各ドキュメントは「現状（調査結果）/ 設計 / 実装フェーズ / 変えないこと / 未決事項 / 検証」の構成。
- 実装が完了したドキュメントは実施記録を追記して `Docs/Done/` へ移す。
- Markdown を更新したら `操作メモ.md` の変更履歴にも要点を1行追記する。

## 変更履歴

- 2026-07-03: `ReferenceFlows/Reference-UnifiedSwitchWorkflow.{json,md}` を追加。ComfySwitchNode（コア組み込み）+ PrimitiveBoolean で全生成モードを1ワークフローに統合したリファレンス。switch のブーリアン接続・lazy 評価・検証がグラフ全体に走る制約は実機検証済み。
- 2026-07-03: 新機能設計ドキュメント5件がすべて実装完了・main へマージ済みとなったため、`Progress-NewFeatures.md` とあわせて `Docs/Done/` へ移動。「進行中」節は現在空。
- 2026-07-02: Docs フォルダ新設。`引継ぎ資料.md` を `Done/RefactoringLog2026-07-02.md` へ移動、`ReferenceFlows/ComfyUI_00147_controlnet.json` を設置、新機能設計ドキュメント5件を起票。
