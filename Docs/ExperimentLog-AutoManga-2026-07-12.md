# 自動漫画 実機検証ログ — 2026-07-12

## MangaQualityV3 / ALICE E01

- 入力: `%USERPROFILE%\Downloads\ALICE_REBOOT_E01.fountain`（警告0、16 scenes、233 dialogues）
- GURUGURU: `GURUGURU_TEST_DB=1`、リポジトリ外の一時data dir
- ComfyUI: Docker `guruguru-sandbox-comfyui-1`、`127.0.0.1:8288`、専用named volumes。本番8188は未使用
- SDXL: `animagine-xl-4.0-opt.safetensors`、10 steps、長辺768、tags方言
- Chroma: `Chroma1-HD-fp8mixed.safetensors`、10 steps、natural方言、sandbox reference workflow

結果:

- `adapt` / `fill` のprepare-only冒頭5ページはいずれも成功。既定を2 panels/pageへ切り替え、可読最小文字サイズを維持した。
- SDXL実画像は5ページ10コマすべて生成成功し、全候補を未採用のreview待ちで保持。ARは10/10が1216×832 bucket、メタデータgate 10/10 pass。
- 決定的な崩壊統計/OCR gateは10/10 pass、OCR偽文字0件。旧tagsコンパイルでは日本語と`0characters`により人物抽象画へ逸脱したが、決定英語タグ変換後は宇宙/月/人型機体を描画した。
- SDXLの白い機体はコマ間でデザインが変化し、参照なしの同一性不足を再確認した。
- Chromaはsandboxで生成完走し配管を確認。日本語heuristic promptではシーン不一致だったため、natural方言にも決定英語化を適用した。
- モデル戦略は既存のPuLID/LoRA配管とキャラシート採用経路を利用できるChroma系を同一性の主経路とし、英語化済みSDXLをアニメ画風の比較/フォールバックとして残す。

## 変更履歴

- 2026-07-12: 初版。MangaQualityV3のprepare-only、SDXL 5ページ実画像、Chroma smoke、統計/OCR結果を記録。
