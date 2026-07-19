# ネームポーズレイヤ機能(LLMアンカー→編集可能骨格レイヤ→ControlNet)

- ステータス: 実装完了(2026-07-20、feature/name-pose-layer)
- 最終更新: 2026-07-20
- 関連: `Docs/Plan-MangaNameV4.md` D4(棒人間CN)、`Docs/Done/Feature-PoseControlNet.md`、`Docs/Reference-MaskAndPoseAttachments.md`

## 概要

ネーム(コマ割り+演出)作成時に、監督LLMへ**キャラごとの粗いアンカー(頭の位置+胴の位置)**を書かせ、
そこから決定的にOpenPose-18骨格を復元して**プランへ永続化**する。骨格はネームスタジオの
**編集可能レイヤ**(キャラ名ラベル付き・キャラごとに色分け)としてページに重なり、関節・全体を
ドラッグで動かせる。**レイヤの前後順=深度**として生成に反映し(手前の骨格が奥の骨格を上書き)、
将来のキャラ別マスクLoRA(regional LoRA)適用の基盤にする。

## ユーザー確認済みの決定事項

- LLMには18関節の座標を書かせない。**粗いアンカー(頭の位置・体の向き)だけ**を書かせ、既存の
  プリセットフィットで骨格へ決定的に展開する(2026-07-19 確定)
- 拡散モデルで下書き画像→ポーズ推定の経路は**今回スコープ外**(将来メモのみ)
- レイヤ順=深度。前面レイヤの骨格が前にあるように生成へ反映する
- キャラ名がついていてキャラごとに色分け。将来のキャラ別マスクLoRA適用の基盤にする

## 現状(調査済み、2026-07-19)

- 棒人間CN(ネームv4 D4、既定OFF): 生成時に `reconstructPanelPoses`(`src/server/panelPoseReconstructor.ts`)が
  `PanelCastSpec.bbox/pose/gazeTarget + shot.size` からプリセット選択+bboxフィットで骨格をその場復元
  → `renderPoseSkeletonSvg` → sharp PNG → `request.controlnet`。**骨格は保存されず編集不能**
- 監督LLM(naming contract v3、`src/server/scriptMangaDirector.ts:42-80`)は座標を出さない。
  `subjects[].position`(9分割セルenum)→固定0.3×0.42 bbox写像(`scriptMangaPlanV2.ts:43-53`)。
  さらに中立ロール規約(`:191`)により `subjects[].ref` が実キャラ名と一致せず、
  **LLMのposition→cast bboxの結線は実質切れている**(castBoxes()フォールバックが常用される)
- `Character.color` は DB/UI に存在(`apiTypes.ts:366-375`、scriptViewの色ドット)が、
  `loadCharacters`(`scriptManga.ts:612-617`)が color を SELECT せず**プラン系へ伝播していない**
- スタジオは「基礎プラン不変+人間編集レイヤ」構造。採用後planの演出差分編集は
  `NamePlanEdit` union + `applyNamePlanEdits`(`scriptManga.ts:3335-3392`、expectedVersion楽観ロック、
  `directionSource:"human"`)→ `updateScriptMangaPlan` → `materializeRun` 再実行
- ビューワーは「コマ枠SVG(scale(1000) g、x∈0..1 / y∈0..page.height)+HTMLオーバーレイ」。
  cast/骨格の描画は現状なし。編集資産: nameLayoutEdit(getScreenCTM+snapshotHistory)、
  poseEditorController(関節/ボーンドラッグ、アセットモーダル内)
- regional LoRA は未実装。基盤候補: `ReferenceSpec.targetRegion`(未使用)、マスク/CN添付パイプライン

## データモデル(additive)

### PanelCastPose(新規、`src/shared/mangaPlanV2.ts`)

```ts
/** コマ内1キャラ分の骨格レイヤ。joints はパネルローカル正規化 0..1(cast.bbox と同系)。 */
export interface PanelCastPose {
  characterId: string;
  /** レイヤ深度。大きいほど手前。CN描画は昇順(奥→手前)で上書き。 */
  depth: number;
  /** OpenPose-18。x,y ∈ 0..1(パネルローカル)、visible は shot/mode 由来+手動トグル。 */
  joints: PosePoint[];
  /** llm=アンカー由来 / reconstructed=ヒューリスティック復元 / human=スタジオで編集 */
  source: "llm" | "reconstructed" | "human";
  /** 復元に使ったプリセット(来歴・リセット用)。 */
  presetId?: string;
}
// PanelSpec に additive: castPoses?: PanelCastPose[];
```

- 座標系はパネルローカル正規化 0..1(`NormalizedBox` と同じ)。コマ枠を後から編集しても骨格は
  相対追従する(非等方スケールで歪むのは cast.bbox と同じ性質、許容)
- `PosePoint` の shape(`{x,y,visible,score?}`)を流用するが、**この文脈では px でなく 0..1**。
  型コメントで明示する
- 深度の既定値: LLMの `layer` 出力 > focalSubject を最前面 > cast 配列順

## 監督LLM出力スキーマ拡張(`scriptMangaDirector.ts`)

`subjects[]` に optional フィールドを追加:

- `castRef`: string。**そのsubjectが演じる脚本上のキャラ名**(非視覚メタデータ)。監督入力には
  cast一覧が存在しない(castは後段のbuildMangaPlanV2で確定)ため、LLMが既に見ている
  source テキスト中の名前で結線する。v3規約の名前禁止は「視覚生成フィールド」対象であり、
  pageIntent と同様の非視覚メタデータとして許容(プロンプトへは一切コンパイルしない)。
  plan ビルド側で name/alias の大文字小文字無視一致 → 旧 ref 一致の順で照合し、
  既存の「position→bbox結線切れ」も同時に修復する
- `head`: `{x, y}` パネルローカル 0..1(小数2桁で十分)。頭部中心
- `torso`: `{x, y}` 同上。腰・胴中心。head→torso が背骨の向きになる
- `layer`: integer 0..3。大きいほど手前(省略時は既定則)

不正・欠落は**そのsubjectの新フィールドだけ捨てて**従来復元へフォールバック(バッチ全体は
落とさない)。サニタイズは `directionFrom`(0..1クランプ、head/torso は両方揃ったときのみ採用)。
システムプロンプトには「castRef は非視覚の結線メタデータ、head/torso は構図上の位置、
ref 等の視覚フィールドの中立ロール規約は従来どおり」を追記する。

## 骨格復元の拡張(`panelPoseReconstructor.ts`)

アンカー(head/torso、px変換済み)がある cast は **2点相似変換フィット**に切り替える:

1. プリセット選択は従来通り(pose/action キーワード → posePresetLibrary)
2. プリセット側の基準点: 頭部中心(nose/eyes/ears の可視点重心)とヒップ中点
3. プリセット基準線分 → アンカー線分(head→torso)への相似変換(回転+一様スケール+平行移動)を
   全関節へ適用。寝そべり・傾きも自然に出る
4. スケールは [パネル短辺の5%, 200%] にクランプ。head≈torso の退化(距離 < パネル短辺2%)は
   従来の bbox contain フィットへフォールバック
5. 左右反転(gaze由来)は従来通りフィット前に適用

出力は従来の px に加えてパネルローカル 0..1 も返せるようにし、`buildMangaPlanV2` が
`castPoses` を組む(演出マージ後、insert/無人/5人以上はスキップ=従来条件)。全コマで
決定的・I/Oなしなので plan 生成時に常時実行し、poseControl 設定とは独立に**レイヤは常に存在**させる。

## 永続化と編集API

- 置き場所: **採用後の `MangaPlanV2`(`script_manga_plans.plan_json`)の `PanelSpec.castPoses`**。
  candidate 側(採用前)には持たせない(演出=骨格の発生源が採用後のため)。
  preflight埋め込み演出planへの対応は将来スコープ
- `NamePlanEdit` union に追加(`src/shared/scriptMangaApi.ts`):

```ts
{ kind: "pose"; panelId: string; characterId: string;
  joints?: PosePoint[] | null;  // null=そのキャラの骨格を削除、省略=変更しない
  depth?: number }
```

- `applyNamePlanEdits`: joints は 18点・0..1域を検証。適用時に該当 `PanelCastPose.source = "human"`、
  `panel.directionSource = "human"`。既存の expectedVersion 楽観ロック+再materialize フローに乗る
- materialize(`normalizePanelCast` 等)が `castPoses` を**落とさない**ことを characterization test で固定。
  cast から外れた characterId の骨格は materialize 時に間引く

## 生成への反映(深度込み)

`buildPoseControlAttachment`(`scriptManga.ts:233-250`)を拡張:

1. `panel.castPoses` があれば**保存済み骨格を優先**(0..1 → 生成px へスケール)。無ければ従来復元
2. **depth 昇順(奥→手前)に描画順ソート**。`buildPoseSkeletonDrawOps` は配列順に描くので、
   手前キャラのボーン/関節が奥キャラを上書きし、オクルージョンがCN画像に現れる
3. poseControl の mode(full/upper/face)は保存骨格にも `visibleJointsForPoseMode` を交差適用
4. CN画像の配色は **OpenPose標準配色のまま**(CNモデルの学習前提。キャラ色はUIレイヤ専用)
5. 深度差のある2人以上のコマは、プロンプトへ中立の前後関係ヒント
   (例: "clear foreground and background separation between figures")を1フレーズだけ注入
   (文言は実装時に調整。キャラ名は入れない=v3規約維持)
6. 添付のON/OFF・strength/endPercent は従来の poseControl 設定のまま(off 既定)

将来メモ: 深度マップCN(キャラシルエットを深度順の輝度で塗る)はテンプレートに深度CNノードが
ある場合の拡張として据える。今回は openpose CN の描画順+プロンプトヒントまで。

## キャラ色の導管とスタジオUI

### 色の導管

- `loadCharacters` の SELECT に `color` を追加 → `StoryGraphCharacterInput.color` →
  `NarrativeEntity.color?: string | null`(additive)
- スタジオは entity.color を使用。無ければ characterId ハッシュ→固定パレットでフォールバック

### 表示レイヤ(演出テイクのみ)

- `name-studio-controls` に「ポーズ」トグル(`data-action="studio-toggle-pose-layer"`、
  `state.nameStudio.showPoseLayer`)。actionRegistry 登録のみで main.ts 非改修
- 各ページの `.studio-page` に絶対配置SVG(`viewBox` はコマ枠SVGと同一、`pointer-events:none`)を
  重ね、パネルローカル 0..1 → ページ座標(panelBounds写像)で骨格を描画
- 配色: ボーン/関節とも**キャラ色1色**(関節はやや濃く)。頭部付近にキャラ名ラベル+深度順
- 描画は depth 昇順(ビューワー上でも手前が上に重なる)

### 編集モード(ページ単位、nameLayoutEdit と同型)

- 入口 `data-action="studio-edit-poses"`(演出テイク・編集可状態のみ)。
  `state.namePoseEdit`(新設)にドラフト(ページ内全パネルの castPoses)+snapshotHistory
- ステージ: `data-pose-stage` + `id="nameStudioPoseRoot"` の scale(1000) g。座標変換は
  getScreenCTM 方式(nameLayoutEditController と統一)
- 操作:
  - 関節ハンドルドラッグ = 関節移動(逆変換で絶対位置)
  - ボーン(太い透明ヒット線)ドラッグ = **骨格全体の平行移動**
  - 関節クリック = visible トグル
  - 選択骨格のフローティングボタン: 前面へ/背面へ(depth入替)、リセット(復元し直し)、削除
  - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y(main.ts keydown チェーンへ追加。Esc はモード終了=キャンセル確認)
- pointer 系は main.ts の pointerdown/move/up/cancel チェーンへ `handleNamePoseEditPointerDown` 等を
  1行ずつ追加(既知パターン)。ハンドラ先頭で「モード有効かつ data-pose-stage 内か」を判定
- 保存: ドラフトと保存済みplanの差分から `{kind:"pose"}` edits を組み、
  `POST /api/script-manga-plans/:planId/edits`(expectedVersion=run.planEditVersion)。
  成功で run 再取得(再承認待ちへ戻る、既存挙動)。409 は取り直して再編集案内

## キャラ別マスクLoRA基盤(今回は基盤のみ)

- `castPoses` が characterId+depth+骨格を持つこと自体が基盤。加えて pure helper
  `src/shared/poseRegion.ts` を新設:
  - `poseCharacterBounds(joints): NormalizedBox` — 関節外接箱+頭部/体格マージン
  - `poseCharacterSilhouette(joints): {x,y}[]` — ボーンをカプセル膨張した近似シルエット凸包
- 生成には未接続(テスト付きの純関数として置く)。将来: シルエット→キャラ別マスクPNG →
  `ReferenceSpec.targetRegion` / マスク添付パイプライン経由で regional LoRA
  (ComfyUI 側の attention mask 系ノード導入とセットで別機能として起票)

## 実装フェーズ(ブランチ: `feature/name-pose-layer`)

1. **P1 共有型+復元拡張**: `PanelCastPose`/`NarrativeEntity.color`/PosePoint 0..1 文脈、
   アンカーフィット(相似変換+クランプ+退化フォールバック)、色の導管、ユニットテスト
2. **P2 監督スキーマ+plan組み込み**: subjects.castIndex/head/torso/layer、検証、
   castIndex→cast結線(bbox写像も修復)、`buildMangaPlanV2` で castPoses 生成、テスト
3. **P3 編集API+生成接続**: `{kind:"pose"}` edit、applyNamePlanEdits、materialize保全の
   characterization、保存骨格優先+depth順CN描画+mode交差+前後ヒント、テスト
4. **P4 スタジオ表示レイヤ**: トグル、キャラ色+名前ラベル+深度順SVGオーバーレイ
5. **P5 スタジオ編集モード**: ステージ+ドラッグ+depth操作+undo/redo+保存
6. **P6 マスクLoRA基盤+仕上げ**: poseRegion helper+テスト、Docs整備、`bun run test` 全緑、
   1680x920 でUI確認、main へマージ

各フェーズ: `bun run typecheck` / `bun run test`(bun test 直叩き禁止=偽陽性)、`git diff --check`。

## 変えないこと

- poseControl 設定の意味(off 既定・strength/endPercent 既定値)と添付パイプライン
- アセット詳細モーダルの既存ポーズ編集(poseEditorController)
- CN画像の OpenPose 標準配色・黒背景
- candidate 側スキーマ(custom_layouts/balloon_hints)と set-layout 系API
- 監督v3の「キャラ名を視覚フィールドへ出さない」規約(castIndex 参照で代替)

## 未決事項

- 前後関係プロンプトヒントの文言(実装時にA/Bで調整)
- 深度マップCN対応(将来)
- preflight埋め込み演出plan(candidate)への骨格編集(将来)
- 拡散下書き→ポーズ推定のブートストラップ経路(スコープ外、将来メモ)

## 実装メモ(2026-07-20)

- 主要ファイル: `src/shared/mangaPlanV2.ts`(PanelCastPose/検証)、`src/server/panelPoseReconstructor.ts`
  (アンカーフィット+reconstructCastPoses)、`src/server/scriptMangaDirector.ts`(スキーマ+directionFrom
  サニタイズ)、`src/server/scriptMangaPlanV2.ts`(castRef結線+castPoses焼き込み)、
  `src/server/scriptManga.ts`({kind:"pose"}編集+storedPanelPoses+materialize間引き)、
  `src/shared/scriptMangaProvidedPlan.ts`(外部plan importでも新subjectフィールドを通す)、
  `src/client/views/namePoseLayerView.ts` + `src/client/namePoseEditController.ts`(スタジオUI)、
  `src/shared/poseRegion.ts`(マスクLoRA基盤 pure helper)
- 実機確認(2026-07-20、テストDB+外部演出plan import): アンカー(head/torso)→骨格のヒップ中点が
  正確に一致(source=llm)、layer→depth反映、スタジオでキャラ色+名前ラベル表示、関節ドラッグの
  座標往復(画面px→パネルローカル0..1→保存)が誤差なし、深度入替・保存→directionSource=human・
  editVersion加算・再materialize を確認
- 外部エージェントがネームJSONを作る場合も `direction.subjects[].castRef/head/torso/layer` を
  そのまま書けば良い(import検証が寛容サニタイズで通す)

## 変更履歴

- 2026-07-20: 実装完了。castIndex案をcastRef(脚本キャラ名の非視覚メタデータ)へ変更、
  provided plan import 経路の対応を追加。
- 2026-07-19: 起票。3方向のコードベース調査(スタジオ層/ビューワー/監督LLM)を反映した初版。
