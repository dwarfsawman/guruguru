# マスク blur / feather 機能

- ステータス: 設計（未着手）
- 最終更新: 2026-07-02

## 概要

inpaint マスクの境界をぼかす（feather）機能。マスク境界の馴染みを改善し、A1111 の "Mask blur" 相当を提供する。UI はフェザー半径スライダー 1 本。

## 現状の仕組み（調査結果）

- マスクは「白 × alpha・透明背景」の PNG。合成式は `finalMask = (samMask OR manualInclude) AND NOT manualErase`（`src/client/maskCanvas.ts:67-94`、操作メモ.md:41）
- 送信経路: `request.inpaint.maskDataUrl` → `POST /api/projects/:id/rounds`（`inpaintRequestForParent` `main.ts:3030-3044`）
- サーバ: `decodeMaskDataUrl`（PNG 限定・8MB 上限、`uploadDataUrl.ts:33-56`）→ 親画像と寸法一致検証 → `storeMaskImage`（`storage.ts:61-79`）→ `uploadImageToComfy` → `patchInpaintLatentPath`（`workflowInpaint.ts:62-155`）
- ComfyUI 側は `LoadImageMask` の **red チャンネル**で読む（`GENERATED_MASK_CHANNEL` `workflowInpaint.ts:19`、操作メモ.md:37）
- マスクは 2 系統に配線される: サンプラ用（`onlyMaskedPadding > 0` なら `GrowMask` で拡張、`workflowInpaint.ts:93-99, 365-379`）と paste-back 用（`ImageCompositeMasked`、grow **前**のマスク。`workflowInpaint.ts:102` — 灰色滲み回避のため分離）

## 設計方針: サーバ側ノード挿入（採用）

クライアント export 時のぼかしではなく、workflow patch 時に ComfyUI core ノードでフェザーを掛ける。

理由:

1. **red channel 問題**: 現行マスクは「白 × alpha」で、alpha だけをぼかしても canvas の unpremultiply の関係で red チャンネルがほぼ二値のまま残る危険がある。クライアント方式はマスク PNG の出力形式（不透明グレースケール化）と空マスク判定（`canvasHasMaskPixels` は alpha 走査 `maskCanvas.ts:131-144`）まで変える必要があり影響が広い
2. クライアントのマスク意味論・draft 構造を一切変えずに済む
3. `GrowMask` 挿入（`addGrowMaskNode` `workflowInpaint.ts:365-379`）という同型の前例があり、characterization test の土台（`workflow.test.ts`）も既にある

### パラメータ

- `InpaintOptions.featherRadius?: number`（px、0〜30、既定 0。`src/shared/types.ts:34-42` に追加）
- `InpaintDraft.featherRadius`（`maskTypes.ts:17-49` + `defaultInpaintDraft` `maskDraft.ts:24-58` に追加）
- **`inpaintRequestForParent`（`main.ts:3030-3044`）の返却 object literal に `featherRadius: draft.featherRadius` を追加**（明示列挙のため、これを忘れると値がサーバへ届かない）
- **`updateInpaintDraftFromControl`（`main.ts:2459`）に featherRadius の分岐を追加**（field 別 if 分岐のため。clamp 0〜30・整数化）
- 正規化: `normalizeInpaintOptions`（`rounds.ts:277-290`）で整数 clamp 0〜30
- 上限 30 の理由: ComfyUI core `ImageBlur` は `blur_radius` INT 1〜31 に加えて **`sigma` FLOAT 0.1〜10.0** の制約があり、`sigma = radius/3` は radius=30 で上限 10.0 にちょうど到達する。sigma 式を変える場合は `clamp(0.1, 10.0)` を入れる。radius 30 超が必要になったら「縮小 → blur → 拡大」の多段構成を検討（未決事項）

### UI

- スライダーを 2 箇所に表示（`onlyMaskedPadding` が既に 2 箇所描画されている前例に倣う）:
  - マスク編集モーダルの `.mask-options-grid`（`assetModal.ts:275-300`）
  - 生成パネルの `renderInpaintSidebarSection`（`generationPanel.ts:236-263`、`hasActiveMaskData` 時のみ表示）
- バインドは `data-inpaint-field="featherRadius"` → `updateInpaintDraftFromControl`（`main.ts:2459`）の既存経路

### ワークフローパッチ

`workflowInpaint.ts` に `addMaskFeatherNodes(workflow, maskConnection, radius)` を追加:

```
MaskToImage → ImageBlur(blur_radius=radius, sigma=radius/3 程度) → ImageToMask(channel=red)
```

- 既存の `resizeMaskForInpaint` の `MaskToImage → ImageScale → ImageToMask` チェーン（`workflowInpaint.ts:222-233`）と同型。ComfyUI **core ノードのみ**使用（カスタムノード非依存）
- `FeatherMask` ノードは使わない（画像外周のフェードでありマスク形状のフェザーには不適）
- 適用箇所（`featherRadius > 0` のときのみ挿入。0 なら無挿入 = 完全後方互換）:
  1. **サンプラ用マスク**: resize → grow → **feather** の順（grow 後に掛ける）
  2. **paste-back 用マスク**（`compositeMaskConnection`）: resize → **feather**（grow なしは現行維持）。境界の馴染みは主にこちらで効く
- `maskedContent` の 4 分岐（fill / original / latent_noise / latent_nothing、`workflowInpaint.ts:116-150`）のうち、**latent_nothing 分岐はサンプラ側にマスクを配線しない**（`workflowInpaint.ts:145-150`、`SetLatentNoiseMask` 非挿入）ため、サンプラ用 feather が効くのは実質 fill / original / latent_noise の 3 分岐。latent_nothing では paste-back feather のみ有効。孤立ノードを増やさないよう、latent_nothing 分岐ではサンプラ側 feather チェーンを挿入しない（現行 `GrowMask` は同分岐で孤立挿入されており ComfyUI 側で実行対象外になる前例はあるが、踏襲はしない）

### プレビュー（第 2 段・任意）

`renderFinalMaskToCanvas`（`maskCanvas.ts:67-80`）は層ごとに `drawImage` する構造（manualErase は destination-out）のため、`ctx.filter = "blur(Npx)"` を層合成中に掛けると destination-out との相互作用でサーバ側の「合成後 blur」と厳密には一致しない（近似プレビュー）。忠実にするなら**合成済み canvas を別 canvas へ filter 付きで転写**する。またこの関数はストローク中の毎 pointermove で呼ばれる full repaint パス（`Fix-MaskPenLag.md` 参照）なので、入れる場合は**ストローク中は無効化し、commit / sync 時のみ適用**する。初期実装ではプレビューなし（スライダー値のみ）で出す。

## テスト

- `src/server/workflow.test.ts` に characterization を追加:
  - `featherRadius` 未指定 / 0 → 既存スナップショットと byte-identical
  - `featherRadius > 0` → 挿入ノード形状（MaskToImage/ImageBlur/ImageToMask の配線・パラメータ）を固定
  - `onlyMaskedPadding` 併用時の grow → feather 順序
- `normalizeInpaintOptions` の clamp テスト（現状 module-private・rounds.ts のテストファイルも無いため、テスト用に export するか、`workflow.test.ts` と同様に純粋部分を分離する）

## 変えないこと

- マスク PNG の生成形式（白 × alpha・透明背景）と red channel 前提
- 寸法一致検証・8MB 上限・`maskedContent` 既定 `original`
- grow マスクと paste-back マスクの分離（灰色滲み回避）

## 未決事項

- 30px 超のフェザー需要が出た場合の多段 blur 対応
- feather をサンプラ用 / paste-back 用の片方だけに掛ける設定は追加しない（両方固定）で良いか — 実画像で確認して判断

## 変更履歴

- 2026-07-02: 起票。サーバ側ノード挿入方式を採用した初版。
