# Plan: ネームV4 — LLMコマ割りの強化(ビート層・複数候補比較・棒人間ControlNet)

> 状態: 起票(2026-07-14)。承認待ち。
> 前提仕様: [Plan-MangaQualityV3.md](Plan-MangaQualityV3.md)(ネーム規格v3、実装済み)、[Feature-MangaPlanV2.md](Feature-MangaPlanV2.md)、[Reference-MangaCompositions.md](Reference-MangaCompositions.md)。

## 目的

LLMによるコマ割り(N1ページネーム+ネーム監督)の質を上げる。具体的には次の5点。

1. **ビート情報をコマ割りに使う** — 物語上の「瞬間」(ビート)をコマ割りより前に抽出し、コマの切り方・大きさ・ページ配分の根拠にする。
2. **reveal/cliffhanger をページめくりに効かせる** — N1が既に出力している `turnHook` を、実際のページ設計・レイアウト選択へ反映する。
3. **コマ割り候補を複数生成して比較・選択できる** — 1回のLLM呼び出しに複数案を出させる(コンテキストが重い)のではなく、**再生成を複数回走らせて候補として貯め**、ワイヤーフレームで見比べて選ぶ。
4. **LLMの人物配置指示から棒人間を復元し、ControlNet条件付けに使う** — ON/OFF可、「顔だけ」等の部分モード付き。
5. **(低優先)数式によるコマ割り生成** — LLMを使わないエネルギーベース探索で候補を量産できるようにする。
6. **レイアウトテンプレート規格との整合と import/export** — 内部モデルの元になった `guruguru-layout-template`(`.guruguru-layout.json5`)を v0.3 へ改定し(2026-07-14 実施済み)、取り込みテンプレの自動漫画参加とエクスポート(ラウンドトリップ)を可能にする。

## 現状(調査結果、2026-07-14 時点の main)

### 現行パイプライン

```
Fountain
 → planScriptManga        決定的束ね(要素数/発話数/文字数の上限のみ)   src/shared/scriptMangaPlan.ts:117
 → N1ページネーム(LLM)     ページ再配分。importance/turnHookを出力      src/server/scriptMangaDirector.ts:189
 → ネーム監督(LLM, 4頁毎)  shot/angle/subjects(9分割)/layout選択        src/server/scriptMangaDirector.ts:203
 → buildMangaPlanV2        V2化。beatsをコマから後付け生成              src/server/scriptMangaPlanV2.ts:254
 → persistPlan/run/tasks   script_manga_plans(plan_json) ほか           src/server/scriptManga.ts:618
 → submitTasks             コマ毎GenerationRequest(txt2img+reference)   src/server/scriptManga.ts:1017
```

### ギャップ台帳

| # | ギャップ | 根拠 |
| --- | --- | --- |
| G1 | **N1の `importance`/`turnHook` が検証後に捨てられる**。`applyPageNaming` は enum を検証するが `ScriptMangaPlan` へ写さず、レイアウトは常に候補先頭(`scriptMangaLayoutCandidates(count)[0]` = 最も平凡なグリッド系) | `src/server/scriptMangaPageNaming.ts:38-47` |
| G2 | **レイアウトを選び直すネーム監督も N1 の意図を知らない**。監督は `allowedLayouts` から選べる(`layoutTemplateId` 適用は scriptMangaDirector.ts:152)が、入力 compact に importance/turnHook が無い。またコマ→スロット対応は読み順固定なので「heroコマが最大スロットに乗る」保証がどこにも無い | `src/server/scriptMangaDirector.ts:209-214` |
| G3 | **コマの確定がビート理解より先**。決定的束ねは意味を見ずにコマ化し、N1は `sourcePanelIds` の統合はできるが**再分割できない**。beats は確定済みコマから1:1で後付け生成される | `src/shared/scriptMangaPlan.ts:157-176`、`src/server/scriptMangaPlanV2.ts:254-266` |
| G4 | **プラン候補・履歴の概念が無い**。プラン作成はrun作成と一体(`POST /api/projects/:id/script-manga-runs` のみ)。再プランは上書き。`planningMode:"provided"` はサーバーにあるがクライアント型・UIから到達不能 | `src/server/scriptManga.ts:1462`、`src/shared/scriptMangaApi.ts:4`、`src/client/views/scriptView.ts:369` |
| G5 | **プラン段階の視覚表示が無い**。プランは件数・警告・(生成後の)画像候補としてしか見えない。一方 `renderPageLayoutSvg`(`PageLayout`→SVG文字列)は既存 | `src/client/views/pageLayoutSvg.ts:124` |
| G6 | **コマ生成が ControlNet を使っていない**。骨格描画(OpenPose-18、`buildPoseSkeletonDrawOps`/`renderPoseSkeletonDataUrl`)、`ControlNetOptions`、`patchControlNetPath`、prune、部分骨格(`removedBones`)まで下流は配管済みだが、`submitTasks` の request に `controlnet` が無い。LLMの人物配置(`PanelCastSpec.bbox/pose/gazeTarget`)はプロンプト文にしか使われない | `src/server/scriptManga.ts:1017-1048`、`src/client/poseSkeleton.ts:119`、`src/server/workflowControlNet.ts:20`、`src/shared/mangaPlanV2.ts:129-138` |
| G7 | **テンプレートは取り込み一方通行で、規格からドリフトしていた**。エクスポートAPIが無い(取り込み原文 `source_json5` は保存済み)。取り込みテンプレは自動漫画のレイアウト候補に参加できない(内蔵のみ、LLM向け説明文がハードコード)。見開きファイルは先頭ページのみ取り込み。`role:"figure"` と裁ち切り(ページ外はみ出し)はアプリだけが持ち、SPEC v0.2 に無かった → **2026-07-14 に SPEC v0.3 として規格側へ取り込み済み**(role正式化・`bleedOvershoot`・`com.guruguru.autoManga`・エクスポート/ラウンドトリップ要件) | `src/server/layoutTemplates.ts:59`、`src/shared/pageLayout.ts:343-412`、`guruguru-layout-template/SPEC.md` |

### 使える既存資産

- レイアウトプリセットはコマ毎の rect/polygon ジオメトリを持つ → **面積プロファイルは決定的に計算可能**。候補数はコマ数 1→2 / 2→3 / 3→8 / 4→4 / 5→1 / 6→1(`src/shared/layoutPresets.ts:311`)。候補先頭が既定なので**並びは変えない**(新プリセットは末尾追加)。
- `describeScriptMangaLayouts()` が LLM向け説明+figureSlot 位置を返す(`layoutPresets.ts:385`)。
- `PanelCastSpec { bbox, pose?, gazeTarget?, expression, action }` + `PanelSpec.shot { size, angle }` — 棒人間復元の入力は既に揃っている。9分割 position→bbox 写像は固定サイズ 0.3×0.42(`src/server/scriptMangaPlanV2.ts:41`)。
- provided plan の検証(`validateProvidedScriptMangaPlan`、全台詞一度ずつ等)は再利用できる(`src/shared/scriptMangaProvidedPlan.ts:67`)。

## 設計

### D1. N1情報の保持と活用(importance / turnHook を効かせる)

**方針: 「新しく賢くする」前に「既に賢い出力を捨てない」。**

1. **保持** — `ScriptMangaPanelPlan` に `importance?: "splash" | "hero" | "normal"`、`ScriptMangaPagePlan` に `turnHook?: "reveal" | "cliffhanger" | "none"` を追加し、`applyPageNaming` で写す。V2側は `PanelSpec` に `importance?`、ページに `turnHook?` を追加(additive、`validateMangaPlanV2` の既存契約は不変)。provided plan スキーマにも optional で受け口を追加。
2. **レイアウト面積プロファイル** — `layoutPresets.ts` に `layoutAreaProfile(id): { areas: number[] }`(reading-order順の面積比。rect は bounds、polygon は靴紐公式)を追加。テストで全プリセットのスナップショットを固定。
3. **決定的レイアウト事前選択** — `applyPageNaming` の `candidates[0]` 固定をやめ、importance構成でスコアリングする:
   - splash → `builtin:splash` / `builtin:splash-bleed`
   - heroあり → 「heroコマの読み順位置 × 最大面積スロットの読み順位置」が一致する候補を優先。次点は面積比の相関。
   - 全normal → 従来どおり候補先頭(既定の互換維持)。
   - 5〜6コマは hero系候補が存在しない(各1種)ため、**hero付き5コマ/6コマプリセットを末尾追加**する(例: `five-hero-top`, `six-hero-right`)。
4. **監督への伝搬** — 監督バッチの compact 入力へ `importance`/`turnHook`/`pageIntent` を含め、システムプロンプトに「heroコマは最大スロットに乗るレイアウトを維持せよ」「turnHook=reveal のページは末尾コマを引きとして演出し、開示は次ページ冒頭に置け」を追加。`validateDirectedMangaBatch` に「監督がレイアウトを変える場合も hero×最大スロット整合を満たすこと」の検証を追加(不一致は reject → 再生成、fallback は事前選択レイアウト)。
5. **ページめくり位置** — 右綴じでは「めくり直前ページ」(見開きの左側)でのみ turnHook が効く。まずは N1 プロンプトへ「turnHook はめくり直前ページ(pageIndex が奇数/偶数どちらかは綴じ設定に依存 — 未決#1)に置くのが望ましい」というソフト指示+スコアリングで扱い、ハード制約にはしない。

### D2. コマ割り前ビート層(Pre-layout Beats)

**方針: ビートを「コマの説明」から「コマ割りの入力」へ逆転する。LLMは物語力学のセンサー、計算できるものはローカルで。**

1. **決定的な原子分割** — 新設 `src/shared/preLayoutBeat.ts`。Fountain 要素を atomic unit へ:
   - dialogue 要素 = 1 unit(分割しない。呼吸単位分割は既存 N1.5 adapt の領分)。
   - action/synopsis 要素 = **文単位 span** に分割(`{ elementId, spanIndex, start, end }`)。「箱を開ける。中には写真がある。」を別コマにできるようにする — 現行の「N1は統合のみ」制約(G3)の解消。
   - ローカル統計を各 unit に付与: 台詞文字数、話者、シーン境界、登場人物候補(既存 `characterIdsForText` 再利用)。
2. **LLMビート注釈ステージ(新設・N1の前)** — 新設 `src/server/scriptBeatAnnotator.ts`。unit 列 → beat 注釈:
   ```jsonc
   {
     "beats": [{
       "unitIds": ["scene-3-element-2:s0"],        // 連続unitの束(順序保存・一度ずつ)
       "kind": "reveal",                            // setup/action/reaction/reveal/decision/transition/pause
       "importance": 0.9,                           // 0..1
       "pageTurnAffinity": 0.8,                     // めくり直前・直後に置きたい度
       "keepAlone": true,                           // 単独コマ推奨
       "desiredScale": "hero"                       // small/normal/hero/splash
     }]
   }
   ```
   検証は決定的(全unit一度ずつ・順序保存・enum)。失敗時は「1要素=1ビート、kind=action」へフォールバック。**結果は script revision 単位で保存・キャッシュ**し(新テーブル `script_beat_annotations`: revision_id, annotator_version, beats_json)、候補を何回再生成しても注釈は1回で済ませる(D3のコスト削減の要)。
3. **N1の入力をビート列へ変更** — sourcePanels(機械束ね)の代わりに beats+ローカル統計を渡し、出力を `panels[].sourceBeatIds` にする。検証: 全ビート一度ずつ・順序保存・シーン境界・コマ内台詞文字量上限(ローカル計算)。beat→`sourceElementIds`/`dialogueOrderIndexes` への決定的展開により、**既存の「全台詞一度ずつ」契約と ScriptMangaPlan の形は不変**。
   - action 文 span の展開は `ScriptMangaPanelPlan.sourceElementIds` の粒度問題を起こす(未決#2)。初期実装は「span 分割は同一 element の span 群が連続コマに分かれる場合のみ許可し、`sourceText` は span テキスト、`sourceElementIds` は元 element id を重複して持つ」で開始し、V2 の `inferSourceIds` / provided validator の一意性検証を「(elementId, spanIndex) 単位」へ拡張する。
4. **beats の前段引き継ぎ** — `buildMangaPlanV2` の後付け beat 生成(G3)を、注釈済みビートからの引き継ぎへ置換。`PanelSpec.beatIds` は複数可(既にstring[])。`MangaBeat` に `kind`/`importance` を additive 追加。デターミニスティック経路(注釈なし)では従来の後付け生成を維持。

### D3. プラン候補の複数生成と比較UI

**方針: 「1呼び出しで3案」はやらない。ビート注釈1回(共有)+N1をk回(1呼び出し1案)で候補を貯める。ワイヤーフレーム比較はコマ割りレベルで行い、重い監督・画像生成は選択後に1回だけ。**

1. **候補の生成単位** — 候補 = N1 結果(ページ割り+importance/turnHook+D1事前選択レイアウト)まで。監督(subjects配置)や画像は候補比較に不要。1候補あたりのLLMコストはN1呼び出し1回。
   - 多様化: 温度(0.3→候補毎に0.2〜0.7)+プロファイル指示(`readability` / `cinematic` / `tempo` をシステムプロンプトに1行追加)。プロファイルはD5導入後にソフトスコア重みへも接続。
2. **保存** — 新テーブル `script_manga_plan_candidates`:
   `id, project_id, script_id, script_revision_id, group_id, profile, temperature, plan_json(ScriptMangaPlan+importance/turnHook), provenance_json, status(active/adopted/archived), adopted_run_id, created_at`。
   既存 `script_manga_plans`/run の FK 意味論には触れない。
3. **API** —
   - `POST /api/projects/:id/script-manga-plan-candidates` `{ scriptId, count?, profiles?, targetPageCount?, panelsPerPage? }` → ビート注釈(キャッシュ利用)+N1×count。候補JSONの配列を返す。
   - `GET /api/projects/:id/script-manga-plan-candidates?scriptId=` → group 毎一覧。
   - 既存 `POST .../script-manga-runs` に `planCandidateId` を追加 → サーバー側で候補 plan を provided 相当として採用し、監督→V2→run を実行。**採用候補のページ割り・レイアウトは監督が変更不可**(監督バッチの `allowedLayouts` を候補の選択レイアウト1件に固定)。採用時に `status="adopted"`+`adopted_run_id` を記録。
   - クライアント型 `ScriptMangaPlanningMode` に `"provided"` 追加は不要になる(candidateId 経由で内部的に provided を使う)が、API型には `planCandidateId?` を追加(`src/shared/scriptMangaApi.ts`)。
4. **ワイヤーフレーム表示** — `renderPageLayoutSvg` を `src/shared/pageLayoutSvg.ts` へ移動(純文字列生成なので移動のみ)し、拡張オプションを追加:
   - importance の塗り分け(hero=強調枠、splash=全面帯)
   - turnHook マーク(ページ右下/左下に ▼reveal / ▼cliff)
   - コマ内の台詞量バー(文字数から)とビートkindアイコン(action/reaction/reveal…)
   - 監督済みプラン用(採用後プレビュー・任意): `cast[].bbox` の丸人間+視線矢印+`textSafeZones` の吹き出し領域
5. **UI(scriptView)** — 「プラン候補」セクションを新設:
   - 候補ごとにページサムネイル横並び(SVG)。総ページ数・平均コマ数・hero/splash数・turnHook数のサマリ行。
   - **候補間でページ割りが異なる箇所のハイライト**(同一 beatId 列を持つページ同士を対応付け、差分ページだけ枠色を変える)。
   - 「追加生成」(同 group に count 追加)/「この案で生成」(→ 既存 prepare フローへ candidateId を渡す)/破棄。
   - 採用・破棄・追加生成の履歴は candidates テーブルに残る(将来D5のranker学習データ)。

### D4. 棒人間復元 → ControlNet 条件付け

**方針: LLMに座標や骨格を出させない。既存の `cast[].bbox / pose / gazeTarget / shot` から決定的にOpenPose-18骨格を組み立て、既存ControlNet配管へ流す。**

1. **テンプレートポーズライブラリ** — 新設 `src/shared/posePresetLibrary.ts`。正規化座標(0..1)のOpenPose-18ポーズを十数種(standing / sitting / walking / running / crouching / pointing / arms-crossed / lying / back-view / profile-left / profile-right …)。既存 `OPENPOSE_JOINT_NAMES`/`OPENPOSE_BONES`(`src/client/poseTypes.ts` — shared へ移動)を使う。
2. **骨格復元** — 新設 `src/server/panelPoseReconstructor.ts`:
   - `pose` 自由文のキーワードマッチ(sit/walk/run/point/stand…)でプリセット選択。マッチしなければ standing。
   - `shot.size` で可視範囲を決める: close-up→頭+肩、bust→腰上、full/wide→全身(見えない関節は `visible:false` → 既存レンダラが自然に描かない)。
   - `bbox` へ fit(アスペクト維持でスケール+配置)、`gazeTarget`/subjects の相対位置から左右向きを決めて反転。
   - 複数人は `MAX_POSE_COUNT`(4)まで。5人以上・insert ショット・`role:"figure"` 以外の無人コマは骨格なし。
   - 将来: ネーム規格v4で監督に `poseId`(プリセットenum)を直接出させる(enumなので検証可能・安価)。初期はキーワードマッチで十分。
3. **サーバー側レンダリング** — `buildPoseSkeletonDrawOps`(canvas非依存)を `src/shared/` へ移し、新設 `src/shared/poseSkeletonSvg.ts` で ops→SVG 文字列化 → サーバーでは sharp で PNG 化(sharpはSVGラスタライズ可)。クライアント canvas 経路(`renderPoseSkeletonDataUrl`)は既存のまま。
4. **注入** — `submitTasks` の request literal(`scriptManga.ts:1017-1048`)へ `controlnet: { poseImageDataUrl, strength, startPercent, endPercent }` を追加。以降は既存パイプライン(`rounds.ts:451` → `comfyProvider.ts` → `patchControlNetPath`)が無変更で処理する。
   - ガード: テンプレに `ControlNetApplyAdvanced` が無い/`featureAvailability.controlnet=false` なら黙ってスキップ(prune済みの経路と整合)。
5. **ON/OFF・部分モード** — run 設定に `poseControl?: { enabled: boolean; mode: "full" | "upper" | "face"; strength?: number; endPercent?: number }` を追加(API型・UIトグル・DB `script_manga_runs` の設定JSON)。
   - `face` = 頭部キーポイント(nose/eyes/ears: 0,14-17)+首のみ描画。`upper` = 腰から上。実装は既存 `removedBones` と同型の決定的ボーンマスク。
   - 既定 OFF(まず実験機能として)。強度の既定は 0.5 / endPercent 0.6 あたりから実機で調整(骨格に絵を縛りすぎると漫画的デフォルメが死ぬため、弱め・早期終了を初期値にする)。
6. **前提の注意** — 効果は ComfyUI テンプレの `ControlNetLoader` が参照する**openpose系ControlNetモデルの品質に依存**(Chroma系での可用性は未決#3)。検証はテスト用インスタンス(port 8288)で行う。

### D5. 数理コマ割りエンジン(エネルギーベース探索) — 低優先

**方針: 学習済みレイアウト拡散モデルは作らない。ビート注釈を入力とする離散探索で同じ思想を学習不要に実現し、D3の候補ソースを「LLM再生成」から「数式量産」へ拡張する。**

1. `P(N|beats) ∝ exp(−E(N)/T)`。ハード制約(全ビート一度ずつ・順序保存・シーン境界・1〜6コマ・台詞収容=文字量×コマ面積の下限)違反は不採用。ソフト項: importance×面積の一致 / pageTurnAffinity×めくり位置 / action→reaction隣接 / レイアウト連続の単調さペナルティ / ページ密度の緩急。
2. 実装: DP/beam searchで基本解 → 温度付きGumbelノイズで多様化 → 局所改善(ビート移動・コマ分割/統合・ページ境界移動・レイアウト差し替え・hero昇格)。新設 `src/server/mangaNameOptimizer.ts` + `mangaNameScorer.ts`。**LLM呼び出しゼロで候補を量産できる**ので、D3のUI・保存・採用ルートをそのまま使い、`profile` の代わりに `temperature` を露出する。
3. スコア重みは、D3で蓄積した採用/破棄/編集ログからのpairwise学習(ranker)で将来調整する。それまでは手調整の固定重み。
4. N1 LLMとの関係: 併存。ビート注釈さえあれば数理エンジンは決定的フォールバックにもなる(現行の決定的パッカーより高品質な安全網)。

### D6. レイアウトテンプレ規格 v0.3 対応と import/export

**方針: 内部モデル(`PageLayout`)は変えない。規格側を v0.3 へ改定済み(2026-07-14、`guruguru-layout-template` の SPEC.md)なので、アプリを規格へ追いつかせる。規格改定の内容 = `panels[].role`(figure)の正式化 / 裁ち切り座標規約と `validation.bleedOvershoot`(既定0.02 = 既存 `PANEL_BLEED_OVERSHOOT` と同値) / `extensions['com.guruguru'].autoManga`(候補参加メタデータ) / エクスポータ・インポータ要件とラウンドトリップ不変条件(SPEC 27節)。**

1. **autoManga の読み取りと候補プール参加** — `normalizeGuruguruLayout` が `extensions['com.guruguru'].autoManga` を読み、`PageLayout.source` へ `autoManga?: { candidate: boolean; description?: string; emphasisPanelIds?: string[] }` として保持する。`scriptMangaLayoutCandidates` を「内蔵 + `candidate:true` の取り込みテンプレ」へ拡張(参加要件は SPEC 23.1: コマ数1〜6、全コマ rect/polygon、bleedOvershoot 検証通過)。`describeScriptMangaLayouts` は `description` があればそれを、無ければ D1 の面積プロファイルから英語説明を自動生成する。`emphasisPanelIds` は D1 の hero スロット判定(面積最大)を上書きする。内蔵候補の並び先頭は不変(取り込み分は末尾追加)。
2. **bleedOvershoot 検証の取り込み時適用** — 現在は preflight(layout-geometry)のみで検証している座標はみ出しを、`normalizeGuruguruLayout` でも SPEC 11.2 どおりに検証する(超過は取り込み時に 400)。
3. **エクスポートAPI** —
   - `GET /api/layout-templates/:id/export` → `.guruguru-layout.json5`(schemaVersion 0.3.0、単ページ)。取り込みテンプレは保存済み `source_json5` を基点に差分マージし、未対応フィールドを温存する(SPEC 27.2 の原文保持 SHOULD)。内蔵プリセットも書き出せる(規格リポジトリへのサンプル還元にも使える)。
   - `GET /api/pages/:id/export-layout` → ページの現在のコマ枠+吹き出し+テキスト(`balloons` / `texts` / `readingOrder`、`plainText` 必須)。吹き出し形状は既存 pageObjects から写像し、ルビは初期実装では出さない(SPEC上 `content` は MAY)。
   - 新設 `src/shared/pageLayoutExport.ts`(PageLayout→json5 オブジェクト、純ロジック)+ サーバ側で JSON5 文字列化。
4. **見開き分割取り込み** — `mode:'spread'` のファイルはページ毎に2テンプレへ分割して取り込む(SPEC 27.2 の MAY 規定。現行の「先頭ページのみ」を置換)。
5. **ラウンドトリップテスト** — 内蔵全プリセット+v0.3 例ファイル(`examples/hero-bleed-figure.guruguru-layout.json5`)で import→export→import を回し、SPEC 27.3 の不変条件(panel id/order/shape座標/frame.style/visible/role/readingDirection/aspectRatio)をテストで固定する。

## 実装フェーズ

| フェーズ | 内容 | 主対象 | 規模 | 依存 |
| --- | --- | --- | --- | --- |
| P1 | D1: importance/turnHook 保持・面積プロファイル・レイアウト事前選択・監督への伝搬・hero付き5/6コマプリセット追加 | `scriptMangaPageNaming.ts` `scriptMangaPlan.ts` `layoutPresets.ts` `scriptMangaDirector.ts` `mangaPlanV2.ts` | 小〜中 | なし |
| P2 | D2: 原子分割・ビート注釈ステージ(キャッシュ付き)・N1入力のビート化・beats前段引き継ぎ | `preLayoutBeat.ts`(新) `scriptBeatAnnotator.ts`(新) `scriptMangaDirector.ts` `scriptMangaPlanV2.ts` `db.ts` | 中〜大 | P1 |
| P3 | D3: 候補テーブル・候補API・共有ワイヤーフレーム描画・比較UI・candidateId採用ルート | `db.ts` `scriptManga.ts` `index.ts` `scriptMangaApi.ts` `pageLayoutSvg.ts`(shared化) `scriptView.ts` `scriptMangaController.ts` | 中〜大 | P1(P2があると候補品質向上) |
| P4 | D4: ポーズプリセット・骨格復元・サーバーSVG→PNG・request注入・ON/OFF/部分モードUI | `posePresetLibrary.ts`(新) `panelPoseReconstructor.ts`(新) `poseSkeletonSvg.ts`(新) `poseTypes.ts`(shared化) `scriptManga.ts` `scriptMangaApi.ts` `scriptView.ts` | 中 | **P1〜P3と独立**(並行可) |
| P5 | D5: 数理エンジン(scorer/optimizer)・温度UI・選好ログ | `mangaNameOptimizer.ts`(新) `mangaNameScorer.ts`(新) | 大 | P2+P3。**低優先** |
| P6 | D6: 規格v0.3対応(autoManga読取・候補プール参加・bleedOvershoot取り込み検証・export API・見開き分割・ラウンドトリップテスト) | `pageLayout.ts` `layoutTemplates.ts` `layoutPresets.ts` `pageLayoutExport.ts`(新) `index.ts` | 小〜中 | P1(面積プロファイル)。**P2〜P5と独立**(並行可) |

推奨着手順: P1 → P2 → P3(P4・P6はいつでも並行可、P5は保留)。P1単独でも「heroが平凡なグリッドに潰される」「revealがページ中腹に埋まる」の改善が見込める。規格側(SPEC v0.3)の改定は実施済みなので、P6はアプリ側の追従のみ。

## 変えないこと

- 全台詞を一度ずつ必ず割り当てる契約と、その決定的検証(N1/監督/provided/数理エンジンの全経路)
- LLM障害時の決定的プランナーへのフォールバック(ビート注釈・N1・監督のどこで失敗しても生成が止まらない)
- `plannerProvenance` による全LLM往復の保存
- レイアウト候補配列の既存順序(候補追加は末尾のみ — 既定構図の互換維持)
- 台詞本文を画像プロンプトへ入れない
- 候補採用の最終決定は常に人間(自動化は推薦まで)
- ネーム規格v3の既存フィールド契約(追加はすべて optional / additive)

## 未決事項

1. **ページめくりパリティの正** — 右綴じで「めくり直前ページ」が偶数か奇数か(表紙・扉の有無で変わる)。Bookモードに見開き概念を足すか、run設定 `firstPageSide?: "recto" | "verso"` で指定させるか。P1ではソフト指示に留める。
2. **action文span分割と sourceElementIds 契約** — `(elementId, spanIndex)` 粒度への拡張が provided plan validator・`inferSourceIds`・エクスポート系へ波及する範囲の確定。P2着手時に spike で影響調査してから本実装。
3. **openpose系ControlNetモデルの用意** — 現行テンプレ(Chroma系)で使えるopenpose CNの選定と、`featureAvailability` への可用性検出追加。P4冒頭にテスト用インスタンス(8288)で品質確認し、使い物にならなければ P4 を「立ち絵(figureスロット)とhero/close-upコマのみ適用」へ縮小する。
4. **候補保存の粒度** — legacy `ScriptMangaPlan` のみ(推奨、軽い)か、V2まで含めるか。
5. **ポーズプリセットの初期セット**(何種類か)と `pose` 自由文キーワード辞書の言語(監督出力は英語なので英語キーワードで開始)。
6. **候補比較UIのサムネイル情報量** — importance色分け・台詞量バー・ビートkindアイコンのどこまでを初期実装に含めるか。
7. **ページ書き出し(`export-layout`)の吹き出し写像範囲** — compound形状・尻尾のpath化・縦書きテキストboxの再現をどこまで行うか(SPEC上は `plainText` のみ MUST)。
8. **内蔵プリセットの規格ファイル同梱** — export APIで生成できるため、規格リポジトリの examples へ内蔵プリセットを還元するかは任意。

## 検証

- 各フェーズ完了時: `bun run typecheck`、`bun test`、`bun run check`(checkはtypecheck/testを含まない)。
- 実機A/B: ALICE E01 を `pageLimit: 5` で、P1前後(同一脚本・同一seed方針)のレイアウト分布(グリッド率、hero一致率、turnHook位置)を比較。
- 新規テスト(既存の命名に合わせる):
  - `applyPageNaming` が importance/turnHook を保持すること、レイアウト事前選択のスコア(hero×最大スロット一致、splash→splash系)
  - `layoutAreaProfile` の全プリセットスナップショット(rect/polygon)
  - 原子分割の往復(span連結=正規化後の原文一致)、ビート注釈validatorのenum/被覆/順序、フォールバック
  - ビート化N1の全ビート被覆・シーン境界・台詞契約の不変
  - 候補API(生成・一覧・採用でstatus/adopted_run_id遷移、採用後の監督レイアウト固定)
  - ワイヤーフレームSVGスナップショット(importance塗り分け・turnHookマーク)
  - 骨格復元(プリセット選択・shot別可視関節・bbox内fit・左右反転・4人上限・無人/insertスキップ)
  - `submitTasks` の controlnet注入(有効時のみ、テンプレ非対応時スキップ、face/upperモードのボーンマスクops)
  - `normalizeGuruguruLayout` の autoManga読み取り・bleedOvershoot検証・見開き分割、候補プール拡張(参加要件の判定)
  - export のラウンドトリップ(内蔵全プリセット+v0.3例ファイル、SPEC 27.3 不変条件、`source_json5` マージによる未対応フィールド温存)

## 変更履歴

- 2026-07-14: D6(レイアウトテンプレ規格v0.3対応とimport/export)とP6を追加。規格側 `guruguru-layout-template` を SPEC v0.3 へ改定(role正式化・bleedOvershoot・com.guruguru.autoManga・エクスポート/ラウンドトリップ要件、v0.3例ファイル追加)。ギャップ台帳へG7を追記。
- 2026-07-14: 初版。現状調査(ギャップ台帳G1〜G6)、設計D1〜D5、フェーズP1〜P5を起票。
