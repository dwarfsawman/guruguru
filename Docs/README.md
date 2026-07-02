# Docs フォルダ

GURUGURU の設計ドキュメント・参照資料の置き場。運用手順・落とし穴は従来どおりリポジトリ直下の `操作メモ.md` に集約する（AGENTS.md の規約）。

## 構成

- `Docs/` 直下 — 進行中の機能設計ドキュメント
- `Docs/Done/` — 完了した作業ログ（例: `RefactoringLog2026-07-02.md` = 旧 `引継ぎ資料.md`）
- `Docs/ReferenceFlows/` — 参照用 ComfyUI ワークフロー JSON（API フォーマット）

## 進行中の設計ドキュメント（2026-07-02 起票）

| ドキュメント | 内容 | 規模感 |
| --- | --- | --- |
| [Feature-PoseControlNet.md](Feature-PoseControlNet.md) | MediaPipe Pose Landmarker による人物ポーズ検出 + 関節編集 + ControlNet 添付生成。タブ UI・棒人間バッジ含む | 大 |
| [Feature-MaskFeather.md](Feature-MaskFeather.md) | inpaint マスクの blur / feather（境界ぼかし） | 小〜中 |
| [Feature-PaintTool.md](Feature-PaintTool.md) | 画像ペイントツール（基本色 + 任意カラー + スポイト、新規アセット保存） | 中 |
| [Fix-MaskPenLag.md](Fix-MaskPenLag.md) | マスクペンのかくつき修正（HW アクセラレーション無効環境） | 小〜中 |
| [Feature-IterationTreeHue.md](Feature-IterationTreeHue.md) | イテレーションツリー配色の改善（色相進行の抑制 + denoise 連動） | 小 |

実装順の推奨: `Fix-MaskPenLag`（ペイントツールも同じ描画パスを使うため先行させる）→ `Feature-IterationTreeHue` / `Feature-MaskFeather`（独立・小規模）→ `Feature-PaintTool` → `Feature-PoseControlNet`（最大。フェーズ分割は各ドキュメント参照）。

## 運用

- 各ドキュメントは「現状（調査結果）/ 設計 / 実装フェーズ / 変えないこと / 未決事項 / 検証」の構成。
- 実装が完了したドキュメントは実施記録を追記して `Docs/Done/` へ移す。
- Markdown を更新したら `操作メモ.md` の変更履歴にも要点を1行追記する。

## 変更履歴

- 2026-07-02: Docs フォルダ新設。`引継ぎ資料.md` を `Done/RefactoringLog2026-07-02.md` へ移動、`ReferenceFlows/ComfyUI_00147_controlnet.json` を設置、新機能設計ドキュメント5件を起票。
