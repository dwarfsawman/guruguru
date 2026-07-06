# Docs フォルダ

GURUGURU の設計ドキュメント・参照資料の置き場。運用手順・落とし穴は従来どおりリポジトリ直下の `操作メモ.md` に集約する(AGENTS.md の規約)。

## 構成

- `Docs/` 直下(`Feature-*.md`) — 進行中の機能設計ドキュメント(現在なし。次の新機能起票時にここへ追加する)
- `Docs/` 直下(`Reference-*.md`) — **随時更新するリファレンス**。完了ログではなく、現行のコードの内部実装・挙動を短く保って上書きしていく(変更履歴は持たない)。運用手順・落とし穴は引き続き `操作メモ.md` に集約する(AGENTS.md の規約)
- `Docs/Refactoring/` — 進行中のリファクタリング計画・記録(現在なし。完了分は `Done/` へ移動済み)
- `Docs/Done/` — 完了した作業ログ・設計ドキュメント(実装当時の経緯・決定事項を残す履歴)
- `Docs/ReferenceFlows/` — 参照用 ComfyUI ワークフロー JSON(API フォーマット)
  - [Reference-UnifiedSwitchWorkflow.json](ReferenceFlows/Reference-UnifiedSwitchWorkflow.json) — txt2img / img2img / inpaint / ControlNet有無 を switch + PrimitiveBoolean で1本化した統合ワークフロー。解説は [Reference-UnifiedSwitchWorkflow.md](ReferenceFlows/Reference-UnifiedSwitchWorkflow.md)
- `Docs/UIMock/` — UI モック(B案ハイファイモック等。[UIRefine-B.md](Done/UIRefine-B.md) が参照)

## 現行リファレンス(`Docs/Reference-*.md`)

| ドキュメント | 内容 |
| --- | --- |
| [Reference-MaskAndPoseAttachments.md](Reference-MaskAndPoseAttachments.md) | マスク編集・inpaint・ポーズ ControlNet 添付の内部実装(合成ルール・patchInpaintLatentPath・roleMap接続トレース・添付トグルUI) |
| [Reference-AssetDetailViewer.md](Reference-AssetDetailViewer.md) | 画像詳細ビューアのマスクツールバー最小化・移動、ズーム/パン |
| [Reference-GenerationPipeline.md](Reference-GenerationPipeline.md) | バッチ生成のジョブ分解・WebSocket監視・停止 |
| [Reference-IterationTree.md](Reference-IterationTree.md) | Workflow diagram(Mermaid)、スクロール位置保持 |

## 完了した設計ドキュメント(`Docs/Done/`)

| ドキュメント | 内容 |
| --- | --- |
| [RefactoringLog2026-07-02.md](Done/RefactoringLog2026-07-02.md) | 第一次リファクタリング(P0〜P2)の調査・実施ログ |
| [第二次リファクタリング計画.md](Done/第二次リファクタリング計画.md) | 第二次リファクタリング(フェーズA〜J-5・UX改善#1〜#8・総括コードレビュー)の計画・実施記録 |
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
| [Feature-ImagePaste.md](Done/Feature-ImagePaste.md) | 画像貼り付け(Paste & Transform)。D&D/Ctrl+V添付・SVGギズモ変形・サーバ永続化・生成時見たまま合成 |

## 運用

- 各ドキュメントは「現状(調査結果)/ 設計 / 実装フェーズ / 変えないこと / 未決事項 / 検証」の構成。
- 実装が完了したドキュメントは実施記録を追記して `Docs/Done/` へ移す。
- `Docs/Reference-*.md` は完了ログとは別物: コードの現状に合わせて上書き更新し、変更履歴は持たせない(履歴は `操作メモ.md` の変更履歴か `Docs/Done/` 側に書く)。
- Markdown を更新したら `操作メモ.md` の変更履歴にも要点を1行追記する。

## 変更履歴

- 2026-07-06: 長大化していた `操作メモ.md` の機能別内部実装セクション(マスク/ポーズ添付・画像詳細ビューア・生成パイプライン・イテレーションツリー)を `Docs/Reference-*.md` 4件へ分離。完了済みの `Feature-ImagePaste.md` を `Done/` へ移動。
- 2026-07-05: 第二次リファクタリングが全フェーズ(A〜J-5・UX改善#1〜#8)+ 総括コードレビューまで完了し、「第二次リファクタリング計画.md」を `Done/` へ移動。
- 2026-07-05: `Docs/Refactoring/` を新設し「第二次リファクタリング計画」を起票。実装済みの設計ドキュメント8件(Pose 系 6 件・UnifiedSwitchWorkflow・UIRefine-B)を `Done/` へ移動し、本 README の構成・一覧を現状に合わせて更新。
- 2026-07-03: `ReferenceFlows/Reference-UnifiedSwitchWorkflow.{json,md}` を追加。2026-07-02 起票の新機能設計5件が完了し `Done/` へ移動。
- 2026-07-02: Docs フォルダ新設。`引継ぎ資料.md` を `Done/RefactoringLog2026-07-02.md` へ移動、`ReferenceFlows/` 設置、新機能設計ドキュメント5件を起票。
