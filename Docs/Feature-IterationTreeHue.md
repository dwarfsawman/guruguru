# イテレーションツリー配色の改善（色相進行の抑制 + denoise 連動）

- ステータス: 設計（未着手）
- 最終更新: 2026-07-02

## 要望

1. 色相の進み方を今より抑える
2. denoise 値が高い round ほど、親からの色相の変化を大きくする（= 画像が大きく変わる生成ほど色も大きく変わる）

## 現状（調査結果）

- hue 計算は 1 関数のみ: `branchHue(round) = ((round.branchColorIndex ?? 0) * 57) % 360`（`src/client/views/iterationTree.ts:109-111`）
- 適用は `renderRoundTreeNode`（`iterationTree.ts:72-107`）が `style="--branch-hue: ${hue}"` としてノードにインライン CSS 変数を設定。CSS 側は `hsl(var(--branch-hue), S%, L%)` で消費（`src/client/styles.css:448, 455, 469, 474, 478-479`。単位なし数値なので小数化しても CSS 変更不要）
- `branchColorIndex` は**サーバ採番**（`branchAssignmentForRound` `roundBranches.ts:12-47`、採番は private `nextBranchColorIndex` `roundBranches.ts:49-54`）: 新しい分岐（新しい親 asset、または新 root）が生まれるたびにプロジェクト内連番 +1。同一親 asset からの再生成は同じ index を再利用（= 同色）。ツリーの深さ・denoise とは無関係
- つまり現状は「分岐が増えるたびに 57° ずつ回る」だけで、親子の色相関係も denoise も反映されない
- denoise はツリーノード（Round）から `round.request.denoise` で取得可能（`Round.request: GenerationRequest` `src/shared/apiTypes.ts:50`、`GenerationRequest.denoise` `src/shared/types.ts:64`。サーバ側 `normalizeDenoise` で常に数値化されるが防御的に `?? 1`）
- `branchHue` の参照は `iterationTree.ts` 内のみ（grep 済み）。iterationTree のテストは存在しない

## 設計

### 新アルゴリズム（クライアント側のみで完結）

```
root:  hue = (branchColorIndex * ROOT_HUE_STEP) % 360
child: hue = (parentHue + CHILD_HUE_STEP_MAX * clamp(denoise, 0, 1)) % 360
```

- `ROOT_HUE_STEP = 57`（現状維持。root 同士の識別性を保つ）
- `CHILD_HUE_STEP_MAX = 40`（denoise=1.0 の子で 40°、img2img 既定 denoise=0.35 で 14°）
- 効果: 低 denoise の微調整チェーンは近い色相にまとまり（従来: 分岐のたびに 57° 飛んでいた）、高 denoise の大変化だけが色相を大きく動かす。「進み方を抑える」と「denoise 連動」を同時に満たす
- 負値対策込みの正規化 `((h % 360) + 360) % 360` を通す

### 兄弟 round の扱い（現状からの意味論変更あり）

新方式では色が「親 round の hue + 自分の denoise」だけで決まるため、現状のセマンティクスから次の 2 点が変わる（採番が親 **asset** 単位・新方式が親 **round** 起点である差に由来）:

1. 同一親 asset からの再生成: 現状は常に同色（`branch_key` 再利用）だが、新方式では **denoise を変えると別色**になる（denoise が同じなら同色）。これは「denoise 連動」の狙いどおりの変化
2. 同じ親 round の**異なる asset** から分岐した兄弟: 現状は別 `branchColorIndex` で別色だが、新方式では denoise が同じなら**同色に衝突**する

2 は許容する（同一 round 内の兄弟はグリッド上で隣接し、ノード位置で区別できる）。区別したくなった場合の拡張として `siblingIndex * SIBLING_STEP`（例 4°）の加算項を用意できる（`renderRoundTreeNode` の再帰呼び出し元 `childRounds.map((child, index) => ...)` `iterationTree.ts:98` で index が既に手元にある）。初期実装では入れない

### 実装箇所（すべて `src/client/views/iterationTree.ts`）

1. `branchHue(round)` → `rootHue(round)` に改名し root 専用に（`ROOT_HUE_STEP` 定数化）
2. hue 遷移を pure 関数 `childHue(parentHue: number, denoise: number): number` として export（定数 `CHILD_HUE_STEP_MAX` と共にファイル冒頭へ）
3. `renderRoundTreeNode` に **`parentHue: number | null = null`** 引数を追加。**root/child の判定は引数の null 判定で行う**（`round.parentRoundId == null` での判定は不可 — orphan round は parentRoundId 非 null のまま root 扱いされるため）: `const hue = parentHue == null ? rootHue(round) : childHue(parentHue, round.request?.denoise ?? 1)`。再帰呼び出し（`iterationTree.ts:100` 付近）には自ノードの `hue` を渡す
4. `renderIterationTracker`（`iterationTree.ts:23-39`）の roots 呼び出しは `parentHue` を渡さない（null 既定）
5. `buildRoundForest`（`iterationTree.ts:41-58`）は親不明 round を root 扱いする。呼び出し元ベースの null 判定にしたことで orphan も root hue パスに乗る（`buildRoundForest` 自体は変更不要）

### テスト

- `src/client/views/iterationTree.test.ts` を新設（初の iterationTree テスト）: `rootHue` / `childHue` の pure 関数を `node:test` で検証
  - denoise 0 / 0.35 / 1.0 / 範囲外（clamp）/ 360 wrap のケース
  - 深いチェーン（denoise 0.35 × 10 世代）で色相が一周しないこと（14° × 10 = 140° < 360°）

### パラメータ調整

- `ROOT_HUE_STEP = 57` / `CHILD_HUE_STEP_MAX = 40` を初期値とし、実ツリーでの見た目確認（ユーザー判断）で調整する。設定 UI 化はしない（定数のみ）

## 変えないこと

- サーバ側 `branch_color_index` の採番ロジック・DB スキーマ・API（`branchColorIndex` は root の色種として引き続き使用）
- CSS（`--branch-hue` の消費側、`src/client/styles.css:448` 等）・ノード DOM 構造
- アクティブノード強調・delete preview などツリーの他の表示挙動

## 未決事項

- `CHILD_HUE_STEP_MAX` の初期値 40° の妥当性（実ツリーで確認して調整）
- 兄弟区別（sibling offset）を将来入れるかどうか

## 変更履歴

- 2026-07-02: 起票。denoise 累積方式の初版。
