# Docs フォルダ

GURUGURU の設計ドキュメント・参照資料の置き場。運用手順・落とし穴は従来どおりリポジトリ直下の `操作メモ.md` に集約する(AGENTS.md の規約)。

## 構成

- `Docs/` 直下 — 進行中の機能設計ドキュメント(現在なし。次の新機能起票時にここへ追加する)
- `Docs/Refactoring/` — リファクタリング計画・記録
  - [第二次リファクタリング計画.md](Refactoring/第二次リファクタリング計画.md) — main.ts 再膨張(6000行)への構造対策・CSS Chrome 150 化・UX 改善・テスト手法(2026-07-05 起票、進行中)
- `Docs/Done/` — 完了した作業ログ・設計ドキュメント
- `Docs/ReferenceFlows/` — 参照用 ComfyUI ワークフロー JSON(API フォーマット)
  - [Reference-UnifiedSwitchWorkflow.json](ReferenceFlows/Reference-UnifiedSwitchWorkflow.json) — txt2img / img2img / inpaint / ControlNet有無 を switch + PrimitiveBoolean で1本化した統合ワークフロー。解説は [Reference-UnifiedSwitchWorkflow.md](ReferenceFlows/Reference-UnifiedSwitchWorkflow.md)
- `Docs/UIMock/` — UI モック(B案ハイファイモック等。[UIRefine-B.md](Done/UIRefine-B.md) が参照)

## 完了した設計ドキュメント(`Docs/Done/`)

| ドキュメント | 内容 |
| --- | --- |
| [RefactoringLog2026-07-02.md](Done/RefactoringLog2026-07-02.md) | 第一次リファクタリング(P0〜P2)の調査・実施ログ |
| [Feature-PoseControlNet.md](Done/Feature-PoseControlNet.md) | ポーズ検出 + 関節編集 + ControlNet 添付生成(基盤) |
| [Feature-PoseCIGPose.md](Done/Feature-PoseCIGPose.md) | CIGPose ポーズ検出(top-down / onnxruntime-web) |
| [Feature-PoseModelSelection.md](Done/Feature-PoseModelSelection.md) | ポーズ検出モデル選択(Full / Heavy) |
| [Feature-PoseMultiPerson.md](Done/Feature-PoseMultiPerson.md) | ポーズ検出の複数人対応(最大4人) |
| [Feature-PoseBoneLengthConstraint.md](Done/Feature-PoseBoneLengthConstraint.md) | ポーズ編集の回転拘束(Shift ドラッグで骨長固定) |
| [Feature-PoseEditRefine.md](Done/Feature-PoseEditRefine.md) | ポーズ編集の改善(Undo / エッジ削除UX / FK ほか) |
| [Feature-PoseControlNet-Img2Img.md](Done/Feature-PoseControlNet-Img2Img.md) | img2img × ControlNet(pose 添付)併用対応。roleMap 誤推論の根本修正 |
| [Feature-UnifiedSwitchWorkflow.md](Done/Feature-UnifiedSwitchWorkflow.md) | 統合 Switch ワークフロー方式(ComfySwitchNode + PrimitiveBoolean) |
| [Feature-MaskFeather.md](Done/Feature-MaskFeather.md) | inpaint マスクの feather(境界ぼかし) |
| [Feature-PaintTool.md](Done/Feature-PaintTool.md) | 画像ペイントツール |
| [Fix-MaskPenLag.md](Done/Fix-MaskPenLag.md) | マスクペンのかくつき修正 |
| [Feature-IterationTreeHue.md](Done/Feature-IterationTreeHue.md) | イテレーションツリー配色の改善 |
| [UIRefine-B.md](Done/UIRefine-B.md) | UI 洗練化(B案モック準拠)リスタイリング記録 |

## 運用

- 各ドキュメントは「現状(調査結果)/ 設計 / 実装フェーズ / 変えないこと / 未決事項 / 検証」の構成。
- 実装が完了したドキュメントは実施記録を追記して `Docs/Done/` へ移す。
- Markdown を更新したら `操作メモ.md` の変更履歴にも要点を1行追記する。

## 変更履歴

- 2026-07-05: `Docs/Refactoring/` を新設し「第二次リファクタリング計画」を起票。実装済みの設計ドキュメント8件(Pose 系 6 件・UnifiedSwitchWorkflow・UIRefine-B)を `Done/` へ移動し、本 README の構成・一覧を現状に合わせて更新。
- 2026-07-03: `ReferenceFlows/Reference-UnifiedSwitchWorkflow.{json,md}` を追加。2026-07-02 起票の新機能設計5件が完了し `Done/` へ移動。
- 2026-07-02: Docs フォルダ新設。`引継ぎ資料.md` を `Done/RefactoringLog2026-07-02.md` へ移動、`ReferenceFlows/` 設置、新機能設計ドキュメント5件を起票。
