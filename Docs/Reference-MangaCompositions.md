# Reference: 漫画の自由な構図(裁ち切り・斜めゴマ・ぶち抜き立ち絵・吹き出し回避)

自動漫画(MangaPlanV2)と手動編集の両方で使える「枠にとらわれない構図」の現行仕様。
**LLM(ネーム監督・provided plan 作者・コード探索エージェント)が構図の選択肢に気づくための入口**でもある。
関連: [Feature-MangaPlanV2.md](Feature-MangaPlanV2.md)(制御層)、[Reference-DialogueAutoLayout.md](Reference-DialogueAutoLayout.md)(吹き出しソルバー)。

## 1. できること(能力の一覧)

| 構図 | 実現方法 | 自動漫画からの使い方 |
| --- | --- | --- |
| 裁ち切り(フチなし)コマ | コマ bounds をページ外へ `BLEED`(0.015)はみ出させる。枠線は紙面外に落ちて描かれない | `builtin:splash-bleed` / `builtin:two-bleed-hero-top` / `builtin:three-bleed-hero-top` / `builtin:three-bleed-vertical` を選ぶ |
| 枠なしコマ(ページ内) | `LayoutPanel.frame = { visible: false, ... }`(全描画経路が対応済み) | 取り込みテンプレ/plan の layoutSnapshot で指定 |
| 斜めゴマ | `PanelShape` の `polygon`(描画・内外判定・生成サイズすべて対応済み) | `builtin:three-diagonal`、または任意 polygon の取り込みテンプレ |
| コマぶち抜き立ち絵(人物切り抜きがコマ枠の上に立つ) | `LayoutPanel.role: "figure"` スロット + 候補採用時の自動切り抜き → `ImageObject`(band:"front"、クリップ無し) | `builtin:three-figure-left` / `builtin:four-figure-left` を選ぶ |
| 吹き出しの顔回避・専有率上限 | ソルバーの `avoidZones` / `maxPanelCoverageRatio`(strict→relax 二段) | 自動漫画は常時ON(plan の cast bbox から自動導出) |

内蔵プリセットの一覧と説明文は `src/shared/layoutPresets.ts` の `LAYOUT_PRESETS` /
`describeScriptMangaLayouts()` が正。LLM ネーム監督にはバッチごとに
`Layout guide: [{id, panelCount, description, figureSlot?}]` として自動で渡される。

## 2. 裁ち切り(bleed)コマ

- 内蔵プリセットは紙端に接する辺を `BLEED = 0.015` だけページ外へはみ出させる。既定枠線
  (太さ 0.006、中心線描画)が丸ごと紙面外に落ちるため、**紙端に枠線が出ず絵が端まで届く**。
- preflight(`panelPreflightValidator.ts` の layout-geometry)は `PANEL_BLEED_OVERSHOOT = 0.02`
  (`src/shared/pageLayout.ts`)までのはみ出しを許容する。それを超える座標は崩れとして error。
- 描画はキャンバス外を自然にクリップするだけなので、PNG/JPEG/ORA/PPTX/プレビュー/クライアント
  サムネの全経路で追加対応は不要(確認済み)。
- 取り込みテンプレ(`.guruguru-layout.json5`)でも同じ座標規約で bleed を表現できる。

## 3. コマぶち抜き立ち絵(punch-out figure)

### データモデル

- `LayoutPanel.role?: "figure"`(`src/shared/pageLayout.ts`): 立ち絵スロット。内蔵プリセットでは
  `frame.visible: false` とセットで使う。`normalizeGuruguruLayout` / `normalizeEditedPageLayout` の
  両方で保持される(編集往復で消えない)。
- `PanelSpec.role?: "figure"`(`src/shared/mangaPlanV2.ts`): plan 側の写し。**正は layout snapshot**
  で、materialize が reading-order 対応(plan `panels[index]` ↔ `orderPanelsByReadingDirection` 後の
  layout パネル)で毎回スタンプし直す。provided plan が書き忘れても機能する。
- `validateMangaPlanV2` は figure スロットに対応する panel の cast が 1 人でないとき
  `figure-cast-count` warning を出す(error にはしない)。

### 生成(プロンプト)

`compilePanelConditioning`(`src/server/panelPromptCompiler.ts`)は `panel.role === "figure"` で
専用分岐に入る: `solo` / 承認済み appearance / `full body, standing figure` / cast の action・expression /
promptBase / **`simple background, plain white background`** を positive に、
`detailed background, scenery, cropped legs...` を negative に置く。シーンバイブル・文字用余白
(textSafeZones)の文言は持ち込まない。白背景は次の切り抜きの成立条件。

### 候補採用時の自動切り抜き

`selectScriptMangaTaskCandidate`(`src/server/scriptManga.ts`)が figure スロットの task を採用すると:

1. `cutoutFigure`(`src/server/figureCutout.ts`)が縁 2px リングの中央値から背景色を推定し、
   縁から到達できる近似色をフラッドフィルで透明化 → chamfer 距離で**白フチ**(短辺の約 1.8%)を
   焼き込み → 透明余白をトリムした RGBA PNG を返す(sharp のみ・決定的)。
2. 切り抜き PNG を `page_media` へ保存(`createPageMediaFromBuffer`、来歴 = `source_asset_id`)。
3. `figure_<panelId>` の `ImageObject`(band:"front"、`clipPanelId: null` = ぶち抜き)をスロット
   下辺アンカーで配置する。横幅はスロット幅の 125% まで隣コマへ張り出してよい。
4. 立ち絵を障害物として、ロックされていない吹き出しを best-effort で再配置する(§4 の制約付き)。
5. 結果は run の `evaluation_json.figures[taskId]` に `cutout` / `fallback-panel-assignment` /
   `failed` として記録される。

前景率が 0.04〜0.72 の範囲を外れる(=無地背景でない・前景が無い)場合は切り抜き不成立とし、
**通常のコマ画像割当へフォールバック**する(枠なしコマとして矩形表示。候補採用は成立)。
再採用時は同じ object id のまま media を差し替え、旧 media は削除する。

- `autoAssignPanelForSelectedAsset`(コマ対象生成の自動割当)は figure スロットをスキップする
  (未加工の矩形が立ち絵の下に敷かれるのを防ぐ)。
- 描画は既存の ImageObject 経路(Paper → コマ画像 → back帯 → コマ枠 → **front帯** → Mosaic)を
  そのまま使うため、PNG/JPEG/ORA/PPTX/プレビュー全対応。クライアントの S2 編集 UI で位置・
  大きさの手直しも可能。
- スケルトン SVG(ページ一覧・テンプレピッカー)は figure スロットを破線で示す。

### レイアウトとの対応規約

- figure スロットは**テンプレート上は読み順の後方**に置く(内蔵2種はどちらも読み順 3 番目)。
- plan の何番目の panel が figure になるかは reading order で決まる。LLM 監督へは
  `describeScriptMangaLayouts` が `figureSlot`(1始まり)として通知する。provided plan 作者は
  `figureSlot` 位置の panel に「単独キャラの決めビート・少なめの台詞」を割り当てること。

## 4. 吹き出しの顔回避とコマ専有率上限

`runDialogueAutoLayout`(`src/shared/dialogueAutoLayout.ts`)の任意入力(詳細は
[Reference-DialogueAutoLayout.md](Reference-DialogueAutoLayout.md)):

- `avoidZones: {x,y,width,height,label?}[]`(page 座標) — strict パスでは重なる候補を除外、
  置けない場合のみ relax パス(重なり面積比のスコア減点のみ)で配置し「緩和」警告を残す。
- `maxPanelCoverageRatio: number` — コマ外接矩形面積に対する吹き出し合計面積の上限。strict では
  超過配置を許さず、非固定アイテムは後続コマへ逃がす。pinned(自動漫画)は relax で同コマ配置。

自動漫画は `ensureDialogueLettering` で plan の cast bbox から**顔領域(bbox 上端 38%)**、figure
スロットは**全身**を回避ゾーンとして常時渡す(上限は 0.45)。`preview/apply/reflow` の HTTP body
でも同名パラメータを受け付け、reflow は `fontScale` も apply と同様に受ける。
配置後の `auditLettering`(風船×顔の重なり率)は従来どおり evaluation に記録される。

## 5. 拡張ポイント(次に足すなら)

- 取り込みテンプレ(json5)側の `role:"figure"` 対応は正規化まで済んでいる。ユーザー製の
  figure/bleed テンプレを `SCRIPT_MANGA_LAYOUTS_BY_PANEL_COUNT` 相当へ載せる仕組みは未実装
  (現状 LLM 候補は内蔵のみ)。
- 立ち絵の白フチ幅・張り出し率(125%)・下辺アンカーは `figureCutout.ts` / `scriptManga.ts` の
  定数。スタイル設定化するならここ。
- 切り抜きの品質判定は前景率のみ。顔検出やユーザー確認 UI を挟むならば
  `materializeFigureForTask` が境界。

## 6. 検証

- `src/shared/layoutPresets.test.ts` — 新プリセットの候補登録・既定不変・bleed 範囲・`figureSlot`。
- `src/shared/dialogueAutoLayout.test.ts` — avoidZones の strict/relax・専有率のスピル/緩和・決定性。
- `src/server/dialogueAutoLayoutApi.test.ts` — API 受け渡し・reflow の fontScale 維持。
- `src/server/figureCutout.test.ts` — 白背景切り抜き・白フチ・非無地背景の不成立・決定性。
- `src/server/panelPromptCompiler.test.ts` — figure 分岐(白背景/solo/シーンバイブル除外)。
- `src/server/scriptManga.test.ts` — figure レイアウト run の end-to-end(採用→ImageObject→
  page_media→割当スキップ→evaluation 記録)。
- `src/shared/mangaPlanV2.test.ts` — `figure-cast-count` warning。
