# Plan: ネームスタジオV5 — パイプライン一本化と、ネームを主役にしたUI

> 状態: **全フェーズ実装完了(2026-07-16、feature/name-studio-v5 → main)**。
> 実装コミット: P1a `c01eedf` / P1b `61e616f` / P1c `62d436e` / P2 (P2コミット) / P4 server `d870703` /
> P4 client / P3a `f60cba2` / P5 `05ae2b2`。テスト1083件+check緑。
> **計画からの逸脱**: (1) 旧候補の一括archive migration(未決#4)は不要になった — parse境界の
> `normalizeLegacyVisualScale` adapter が旧候補を無害化するため。(2) ポーリングのhidden時挙動は
> 「完全skip」でなく低頻度(20秒毎)へ — バックグラウンドで開きっぱなしの共有ページが主用途のため。
> (3) 差分編集は既存PATCHのpayload判別でなく専用 `POST /:planId/edits`(検証指摘どおり)。
> (4) P3b(生成カタログ)は計画どおり決定ゲートで未着手 — まず手書き10種(P3a)の効果を実運用で計測する。
> (旧状態: 計画・承認待ち、2026-07-16 起票、同日第3者レビュー反映)
> 方針: **後方互換を要求しない**(ユーザー指示。ただし範囲は「互換範囲」節で明示)。シンプルで強いプロダクトを優先し、
> 並行フォールバック・重複概念・二重のレイアウト選択を「残して上に足す」のではなく**削って一本化する**。
> 先行: [Plan-MangaNameV4.md](Plan-MangaNameV4.md)(P1〜P4・P6済み)。[Plan-NameReaderUI.md](Plan-NameReaderUI.md)
> (保守版UI計画)は本計画に**置換**される(D6/D7へ吸収)。

## プロダクト像(何がすごくなるか)

script画面の主役を「設定フォームとカードの列」から**ネームそのもの**に変える。

```
┌ ネームスタジオ ──────────────────────────────────────────┐
│ テイク: [A ビート化] [B cinematic] [C tempo] [+追加]   ● 3/3 到着 │
├──────────────────────────────────┬─────────────────────┤
│  p3 / 12   ◀ ▶                    │ コマ③ インスペクタ      │
│  ┌────────────────────────┐      │  サイズ: 大(0.42)      │
│  │ ① 大 ★  [reveal]         │      │  ビート: reveal         │
│  │ 内容: 炎上中の配信サムネ…   │      │  台詞: 1件 12字         │
│  ├───────┬────────────────┤      │  (採用後: カメラ/人物/   │
│  │ ② 中    │ ③ 小            │      │   構図/prompt を編集)    │
│  └───────┴────────────────┘      │                       │
│  レイアウト: [◆現案] [◇案2] [◇案3]  ← ページ毎に即差し替え・戻せる │
│    理由: 大ゴマが最終revealに一致 / 台詞収容OK / 前頁と別リズム   │
├──────────────────────────────────┴─────────────────────┤
│ ページ意図: …  めくり: ▼reveal      [この案で生成]              │
└─────────────────────────────────────────────────────┘
```

- **ネームがテキストで読める**(添付ネーム画像の形式)。コマ枠+コマ内テキスト、ページ意図、めくり。
- **ページ毎にレイアウト候補top-3をその場でパラパラ差し替えられる**。検索は決定的な共有純関数なので
  LLM待ちゼロ・ネットワーク往復ゼロで即切り替わり、構造化された選定理由とスコア内訳も見える。ここが体験の核。
  top-3は単なるスコア上位ではなく**見た目が違う3案**(diverse top-k)。
- テイク(物語構成の違い)とレイアウト(見た目の違い)が直交する。「N1再実行=構成の別案」「フリップ=同じ構成の見た目違い」
  が概念として分離され、ユーザーが何を選んでいるのか常に明確。元のLLM案は不変なので**いつでも戻せる**。
- エージェントがAPIで作業中も、開きっぱなしのページにテイクが生えてきて、人間が読んで選び、エージェントが待ち合わせる。
- 採用するとその場で演出ネーム(カメラ・人物・台詞本文)に変わり、修正して承認→生成。

## 何を削るか(削除台帳)

調査済みの影響範囲つき。テスト移行は合計 **約60〜80件 / 約17ファイル**(リポジトリ全体 ~1000件)。

| # | 削除対象 | 影響範囲(調査済み) |
| --- | --- | --- |
| X1 | **従来コマ束ねN1**(`applyPageNaming`/`createPageNamingSchema`/panels分岐) | 消費者は `generateScriptMangaN1Plan` のpanels分岐(scriptMangaDirector.ts:317-340)のみ+テスト~4件。三段→**二段フォールバック**(ビート化N1→決定的ビートパッカー、D2)へ。`mode:'panels'` リテラルの読み取りは他に4箇所(candidateView=server / candidateModeBadge=client / scriptMangaApi型union / ScriptMangaN1Result型)— これらの分岐を消した後は、未知値フォールバック(空バッジ/null化)によりDB残存の `'panels'` provenance は空表示で安全 |
| X2 | **スケール表現の重複**(`AnnotatedBeat.importance:number`+`desiredScale`、`MangaPanelImportance`) | 単一enum `MangaVisualScale` へ(D1。ビート側は `preferredScale`、コマ側は `visualScale` と**フィールド名は分ける**)。literal読み取り~12箇所+テスト移行の主戦場。`validateMangaPlanV2` はimportanceを検証していない(additive)ので plan validation は無傷 |
| X3 | **監督のレイアウト選択権**(schema必須の `layoutTemplateId`、`lockLayouts`、allowedLayouts/layoutGuideプロンプト、alignment検証) | `lockLayouts` の設定元は candidate採用経路1箇所のみ。削除で監督は shot/angle/subjects/emotion/composition/prompt だけに。`describeScriptMangaLayouts` は監督経路の消費者を失うが、テンプレエクスポートの `builtinAutoManga`(layoutTemplates.ts:213)が残るため**共用のまま** D3 の理由文生成にも使う |
| X4 | **`selectScriptMangaLayoutId`(単一選択)** | 呼び出し元は両N1バリデータの2箇所のみ → 実現可能性ゲート+`rankLayouts`(D3)へ置換 |
| X5 | **planningMode のUI**(heuristic/llm select) | UIから削除し既定をビート化N1へ。**API値 `heuristic`/`provided` はサーバーに残す**(下記「消してはいけないもの」) |
| X6 | **レイアウト候補配列の「先頭が既定・末尾追加のみ」互換規約**とそれを固定するテスト | rankLayouts 化で並び順が意味を失う |

### 消してはいけないもの(調査で判明した地雷)

- **`planningMode:"provided"` と successor/repair パイプライン** — successor run が hard-require(scriptManga.ts:3006)、
  `materializeRun` が保存済み config の値でprompt方言を選ぶ(:1351)、エージェント運用ドキュメントの正式経路、テスト~22件。不可侵。
- **`planScriptManga`(旧決定的プランナー)** — provided検証の期待台詞数・heuristic API値・旧runとの境界で load-bearing
  なので**残置**する。ただし**V5の通常フォールバックには使わない**(D2: ビートを入力にしない旧設計のため。
  「LLM全損でも生成が止まらない」不変条件は fallbackビート+決定的ビートパッカーが引き継ぐ)。
  現行ビート経路が `deterministicBase` として依存している targetPageCount 既定と title も D2 で units 由来へ置換し、
  ビート経路の `planScriptManga` 依存をゼロにする。
- **監督のバッチ単位フォールバック**(失敗ページは未演出で進む)と**全台詞一度ずつ契約**。
- 決定的候補のグループ内重複排除(`json_extract` が `pageNaming.mode='deterministic'` を見る — mode値の温存理由)。

## 設計

### D1. スケール語彙の一本化(preferredScale / visualScale)

**enumは一つ、フィールド名は二つ**: `type MangaVisualScale = "small" | "medium" | "large" | "splash"`。
ビート側は「希望」、コマ側は「ページ全体を踏まえて解決された値」であり、同名にすると混同するため
`AnnotatedBeat.preferredScale` / `PanelSpec.visualScale`(および `ScriptMangaPanelPlan.visualScale`、
`MangaBeat.preferredScale?`)と呼び分ける。

1. **ビート注釈** — `AnnotatedBeat` から `importance:number` と `desiredScale` を削除し `preferredScale` のみに。
   LLMはカテゴリだけ判断(数値重みはコード側: small 0.6 / medium 1.0 / large 2.0 / splash ページ専有)。
   スキーマ・プロンプト・`fallbackBeatAnnotation`(→medium)を更新。**`BEAT_ANNOTATOR_VERSION` を `beat-annotator-v2` へ必ずbump**
   (キャッシュは `(script_revision_id, annotator_version)` キーなので旧キャッシュは自然に無効化。bumpしないと旧行が新validatorに
   かかって黙って捨てられる/誤通過する)。
2. **N1はスケールを再出力しない** — コマの解決値は純関数へ集約:
   ```ts
   derivePanelVisualScale(beats: AnnotatedBeat[], pageContext: {
     turnHook?: MangaPageTurnHook; panelIndex: number; panelCount: number;
   }): MangaVisualScale
   ```
   基本は含有ビートのmaxだが、maxだけでは足りない規則を持つ:
   - **決定的validator(hard)**: splashは単独コマ・単独ページ / `keepAlone` ビートは他ビートと同居不可 /
     largeビートを複数含むコマは不許可 / 1ページのlargeコマは原則1つまで
   - **derive内のソフト規則(初期は任意)**: turnHook=revealページの最終コマは一段階引き上げ可 / pauseは束ね時に縮小可
   これらはLLMプロンプト任せにせず、N1 validatorで決定的に検査する(違反はreject→再生成)。
3. **伝搬** — `ScriptMangaPanelPlan.importance`→`visualScale`、`PanelSpec.importance`→`visualScale`、
   `MangaBeat.importance:number`→`preferredScale`。ワイヤーフレームのhero/splash塗りは large/splash 塗りへ、
   smallは減光表示を追加。provided-plan validator のenum whitelistも更新。
4. **旧語彙の入力境界は3箇所** — adapter `normalizeLegacyVisualScale({importance, desiredScale, visualScale})` を
   (a) 永続 plan/candidate のparse直後、(b) `planningMode:"provided"` の `directorPlan` 入力、(c) `successorPlan` 入力に置く。
   (b)(c)はDBを経由しない生のAPI入力なので(a)だけでは守れず、provided validator が旧 `importance` を拒否すると
   「不可侵」のはずのエージェント経路(~22テスト)が壊れる。**provided validator は当面 `importance`(hero→large,
   normal→medium写像)と `visualScale` の両方を受理**し、P6でエージェント向けドキュメントを新語彙へ更新する。

### D2. パイプライン一本化と決定的ビートパッカー

```
Fountain
 → Atomic Units(preLayoutBeat、既存)
 → ビート注釈(LLM, preferredScale/kind/keepAlone/pageTurnAffinity)
    └ LLM失敗時は fallbackBeatAnnotation(既存・必ずビート列を返す)
 → ビート化N1(LLM, ビートの束ね方+pageIntent+turnHookのみ)
    └ 失敗時 → packAnnotatedBeatsDeterministically(新設)      ← ここが変更点
 → PanelDemand+実現可能性ゲート+rankLayouts(決定的)           ← D3
 → 構造ネーム候補(テイク)
 → 人間: スタジオで読む・フリップ・選ぶ                          ← D5
 → 監督(LLM, 演出のみ。レイアウト不可侵)                         ← X3
 → MangaPlanV2 → 生成(既存)
```

1. **決定的ビートパッカー(新設)** — 旧 `planScriptManga` はFountain要素を直接束ねるため、
   「ビート注釈は成功したのにN1だけ失敗した」場合にビート情報(preferredScale/keepAlone/シーン境界)を全部捨ててしまう。
   これはV5の中心思想と矛盾するので、**注釈済みビートを入力にする**純関数を新設する:
   ```ts
   packAnnotatedBeatsDeterministically(input: {
     units: PreLayoutUnit[]; beats: AnnotatedBeat[];
     targetPageCount?: number; maxPanelsPerPage: number;
     maxDialoguesPerPanel: number; maxDialogueCharactersPerPanel: number;
   }): ScriptMangaPlan
   ```
   ビート注釈は失敗時も必ずfallbackビートを返すので、**ページネーム段階の入力は常にビート列**になる
   (例外: units自体が空=可視要素ゼロの脚本では beats も空。パッカーは空入力を明示エラーで返し上流が既存の
   空スクリプト扱いへ倒す)。`pageNaming.mode` は `'beats' | 'deterministic'` の2値
   (deterministicの実体がビートパッカーに変わる。グループ内dedupeの `json_extract` 条件は無変更で機能)。
2. **パッカーの充足保証(最終フォールバックが絶対に失敗しないための逃げ道)** — 現行はどんな入力でも
   `planScriptManga` が黙って救済している(文字量capは束ねのヒューリスティックであり検証ではない)。パッカーを
   最終段に据えるなら、検証仕様の側に決定的な例外を明文化しないと**充足不能な入力が存在する**:
   - **単独超過unitの例外**: `maxDialogueCharactersPerPanel` を単体で超える台詞要素は原子unit(分割不可)なので、
     「超過unitを1つだけ含むコマは合法」とする(validator側も同じ例外を持つ。現行 planScriptManga の実挙動の明文化)
   - **ビートの連続分割**: LLM注釈が `maxDialoguesPerPanel` を超えるunit数のビートを作った場合に備え、パッカーは
     ビートを**連続するコマへ分割**できる(sourceBeatIds の被覆検証を「全ビートが連続コマ列で一度ずつ・順序保存」へ緩和。
     span分割elementIdの重複保持と同じ既存前例)。これにより注釈キャッシュが run 毎の cap 設定
     (`maxDialoguesPerPanel` は1〜8で可変)と無関係に再利用できる
   - **ページ数バンドの適用除外**: `targetPageCount ±20%` バンドはLLM出力への制約であり、パッカー出力には適用しない
     (validatorをバンド/実現可能性ゲートを個別にon/offできる形に分解して両経路で共用する)
3. **ビート経路の既定値も units 由来へ** — 現行の targetPageCount 既定(`max(決定的プラン頁数, 台詞数/5)`)と title は
   `planScriptManga` 出力に依存している。台詞数は units から導出し、title は `doc.titlePage.Title || "Manga"`
   (planScriptManga と同式)にして、ビート経路の旧プランナー依存を断つ。
4. X1のとおり中間の従来N1を削除。「LLMは演出意図、コードは幾何」の責務分離がこれで初めて成立する。

### D3. PanelDemand・実現可能性ゲート・rankLayouts

新設 `src/shared/layoutFeatures.ts` + `src/shared/layoutMatcher.ts`(**共有純関数** — クライアントも同じ関数で
top-kを計算できるので、フリップUIがゼロレイテンシになる)。

1. **PanelDemand(コードが算出)** —
   ```ts
   interface PanelDemand {
     visualScale: MangaVisualScale;        // derivePanelVisualScale の解決値
     minAreaFraction: number;              // TextDemand から算出(下記)
     preferredAspect: "wide" | "tall" | "square" | "any";  // 初期は"any"固定(監督前でshot情報が無いため)
     requiredRole?: "figure";              // 必須条件(明示指定時のみ)
     preferredPresentation?: "framed" | "bleed";  // 希望条件(splash→bleed優先、large reveal→bleed微加点)
   }
   ```
   roleを「完全一致×100点ペナルティ」にすると裁ち切り候補が不当に排除されるため、**必須(require)と希望(prefer)を分離**する。
2. **TextDemand(可読性の下限)** — 文字数だけでは「1風船60字」と「4風船15字×4」を区別できないため:
   ```ts
   interface TextDemand {
     totalCharacters: number; balloonCount: number;
     semanticKinds: string[]; writingMode: "vertical" | "horizontal";
   }
   estimateMinimumPanelArea(textDemand: TextDemand): number   // PANEL_TEXT_DEMAND_VERSION = "text-demand-v1"
   ```
   初期は簡易式でよいが、**関数とバージョンを独立させて**後から較正できるようにする。入力は既存の
   `PreLayoutUnit.dialogueCharacters`・`dialogueOrderIndexes`件数・dialogue行の semanticKind。
3. **hard constraint と soft preference の分離** —
   - hard: コマ数一致 / splash単独 / requiredRole=figureなのにfigureスロット無し / `slotArea < minAreaFraction` の
     絶対下限割れ / 解決不能なレイアウト
   - soft: visualScaleと実面積の差 / aspect不一致 / preferredPresentation不一致 / 前ページとの類似(repetition)
4. **実現可能性ゲート(N1 validatorへ追加)** — rankLayoutsは「違反が最小のレイアウト」を返してしまうため、
   **N1出力の受理前に「hard constraintを全て満たすレイアウトが少なくとも1件存在するか」をページ毎に検査**し、
   無ければそのN1出力をreject→再生成する(generateStructuredJsonの再試行は最大3回、その後パッカーへ)。これが無いと
   「UIでは良さそうに見えたのに生成preflightで落ちる」候補が保存される。
   決定的ビートパッカーは構築時に同ゲートを満たすよう束ねる(満たせない場合はコマ分割を増やす。D2の充足保証
   =単独超過unit例外+ビート連続分割+バンド適用除外により、パッカーは常にゲートを満たす出力を構成できる。
   なお `maxPanelCount` 超過は既存仕様どおり明示的な生成キュー投入拒否のままでよい)。
5. **rankLayouts(diverse top-k)** —
   ```ts
   rankLayouts(demands: PanelDemand[], context: { previousLayoutId?: string }): RankedLayout[]
   selectDiverseLayouts(ranked, { count: 3, similarityThreshold: 0.85 }): RankedLayout[]

   interface RankedLayout {
     layoutId: string;
     score: number;
     costs: { area: number; capacity: number; aspect: number; role: number; repetition: number };
     hardViolations: string[];            // ゲート用。表示候補は常に []
     reasons: LayoutReason[];             // 構造化コード(文字列直書きしない)
   }
   type LayoutReason =
     | { code: "large-slot-aligned"; panelIndex: number }
     | { code: "text-capacity-ok" }
     | { code: "avoids-previous-layout" }
     | { code: "bleed-preferred" }
     | { code: "capacity-tight"; panelIndex: number };  // など。UI側で日本語化
   ```
   - 上位3件をそのまま返すと生成カタログでは「上40%/60%と上42%/58%」のような実質同案が並ぶため、
     面積プロファイル・大ゴマ位置・分割軸・隣接構造の類似度で**間引いた3件**を返す(体験を左右するのはカタログ総数より
     「上位3件が目で見て違うこと」)。
   - 初期のrepetitionは前ページのlayoutIdのみ。**ページ列全体のDP最適化**(隣接類似コスト込みで系列を解く)は
     品質差を出せる将来拡張として未決#8に置く。
   - 両N1バリデータの `selectScriptMangaLayoutId ?? candidates[0]` を「ゲート→feasible内のtop-1」へ置換。
     外部テンプレの `autoManga.emphasisPanelIds` 尊重(`emphasizedSlotForLayout`)は維持。

### D4. テンプレートカタログの拡充(決定ゲート方式)

**このDはP2+P4を出して計測してからの決定ゲート**とする。スタジオの核体験(ゼロレイテンシのdiverse top-3フリップ)は
既存の内蔵21種+取り込みv0.3テンプレだけで成立する(3コマは8種ある)。薄いのは4〜6コマ(4種/2種/2種)だけなので:

0. **P3a(第一手・小)**: 4〜6コマの**手書きプリセットを~10種追加**する(既存 `builtin:` 方式・ID安定・新機構ゼロ)。
   多様性指標(下記6)がこれで満たされるなら**ジェネレータは作らない**。
1. **P3b(条件付き)再帰分割ジェネレータ** — 指標がなお不足する場合のみ。新設 `src/shared/generatedLayoutCatalog.ts`。上下/左右の分割木(深さ≤3、比率
   {1:1, 1:2, 2:1, 2:3, 3:2})から2〜6コマのrectレイアウトを機械生成。規約は既存プリセットから抽出済み:
   `page.height=257/182≈1.4120879`、`MARGIN=0.04`、`GUTTER=0.02`、座標丸め1e-6、rtl読み順(行内右→左)、
   `DEFAULT_PANEL_FRAME`。
2. **IDは正規化ハッシュ+バージョン**: `gen:v1:<canonical-layout-hash>`。ハッシュ入力は**固定小数点整数へ正規化した
   完全なレイアウトJSON**(浮動小数のままハッシュしない)。dedupe用の量子化シグネチャはID には使わない
   (量子化は近似形状を同一視するためIDとして弱い — dedupeとIDを分離する)。
3. **バージョン固定** — 候補provenanceへ `{ namePlanVersion: 5, layoutCatalogVersion, layoutMatcherVersion,
   panelDemandVersion }` を保存。ジェネレータや比率集合を変えると旧候補の `gen:` IDが解決不能になり得るため、
   **catalogVersionが現行と異なる候補は採用409で再生成を促す**(採用後は `layoutSnapshot` が固定するので安全。
   採用前候補にもsnapshotを持たせるかは未決#5)。
4. **配置は共有コードモジュール**(DBに入れない)— 外部テンプレ機構(`setExternalScriptMangaLayouts`)は
   サーバー/クライアントが別インスタンスの配列をrefreshで**丸ごと上書き**するため生成分が消される。DB置きは
   `/api/layout-templates` 応答と手動ピッカーを数百件で汚染する。共有コードなら決定的にバイト同一で両側に存在し、
   API/DB変更ゼロ・クライアント解決即時。`resolveScriptMangaLayout` を builtin/external に加えて generated も引くよう拡張。
5. **特殊形は手作業のまま** — 既存の hero/裁ち切り/figure/splash 系builtinと取り込みv0.3テンプレはそのまま候補プールに
   共存(斜めゴマ・変形はここに足す。ジェネレータは基本形だけ)。**1〜6コマ上限は維持**。
6. **ゲートの判定指標(規模より多様性)** — 目標件数は固定しない。「2〜6コマ毎の視覚ファミリー数」「largeスロットが
   読み順の各位置に存在するか」「top-3の平均類似度」「人間が2位/3位へフリップした率」で判定し、
   P3a(手書き)→それでも不足ならP3b(ジェネレータ)の順に投資する(検証節)。

### D5. ネームスタジオ(構造ネーム)

置き場所は既存script画面の候補カードの**位置に置換**(mainの領域構成・`scriptScreenOpen` ゲート・serialガードを
そのまま継承する。画面まるごとの三ペイン化は未決#6の将来案)。スタジオ内部は 中央リーダー+右インスペクタ の2ペイン
(`.page-panel-editor-body` の `minmax(0,1fr) minmax(330px,390px)` グリッド先例を踏襲)。

1. **テイクバー** — 候補グループをテイクA/B/…として表示(バッジ: ビート化N1/決定的、profile、T)。追加生成・破棄。
   テイク間diffは既存 `candidatePageSignature` を流用してページ枠色で表示(ビート基準なのでフリップでは変化しない)。
2. **リーダー** — [Plan-NameReaderUI.md](Plan-NameReaderUI.md) D1をそのまま吸収: SVGワイヤーフレーム背景+コマbboxへの
   HTMLオーバーレイ(読み順番号・visualScale・ビートkindチップ・カメラ・見せる内容・固定revisionの話者/台詞本文)、ページ送り、
   pageIntent/turnHookフッター。紙面内はアプリのdark themeから独立した濃いink色にする。小さいbboxは本文を隠してhover/focus時に
   詳細カードを出し、全コマともクリックで同内容の読取専用ポップアップを開く。幾何は既存 `panelBounds`(pageLayout.ts:217)流用+
   `top=y/page.height` 変換+bleedクランプ。
3. **レイアウトフリップ(基礎プランは不変)** — LLMが生成した `plan_json` は**書き換えない**。人間の選択は別レイヤーに持つ:
   ```
   script_manga_plan_candidates に追加:
     layout_overrides_json  -- Record<pageIndex, layoutTemplateId>。人間のページ別選択
     edit_version           -- 楽観的ロック用整数
   表示・採用時: effectivePlan = applyLayoutOverrides(basePlan, overrides)   // 共有純関数
   ```
   ```http
   POST /api/script-manga-plan-candidates/:id/set-layout
   { "pageIndex": 2, "layoutTemplateId": "gen:v1:abc123", "expectedVersion": 4 }
   → 200 { "version": 5, "effectivePlan": { … } }   （versionずれは409）
   ```
   検証: 非archived・最新revision・コマ数一致・候補プール内・hard violationなし。採用済み/採用中は409。
   overrideを消せば**元のLLM案へ即戻せる**。エージェントとブラウザの同時操作は expectedVersion で衝突検出。
   将来の選好学習でも「生成案」と「人間の修正」が区別できる。
   **候補一覧/ビューAPIにも `layoutOverrides` と `editVersion` を追加**し、クライアントは常に
   `applyLayoutOverrides(candidate.plan, candidate.layoutOverrides)` を描画する(リロード・ポーリング後もフリップが
   巻き戻らない。envelope の beatKinds/dialogueChars と diff署名は override 非依存なので無変更)。
4. **採用(フリップとの競合防止)** — 既存の `planCandidateId` 付き run 作成のまま(サーバーは effectivePlan を採用対象に
   する。監督スキーマにlayoutが無いので「採用後レイアウト不変」は構造的に保証される)。ただし採用は監督LLM実行を挟んで
   数分かかるため、**採用開始時に候補を `status='adopting'` へ遷移**(失敗時 `active` へ戻す)させ、この間の set-layout を
   409にする。これが無いと「採用処理中に人間がフリップ→受理されたように見えるがrunには反映されない」lost updateが
   D7の併走環境で日常的に起きる。採用リクエストにも `expectedVersion` を含め、読み取り時点のversionを検査する。
5. **設定カードのスリム化** — planningMode select 削除(X5)。テンプレ・密度・audit・poseだけ残す。

### D6. 演出ネーム(採用後の閲覧+編集)

Plan-NameReaderUI.md の D4/D5 を吸収し、レビュー指摘の2点を変更:

- 同じスタジオが採用後は `run.plan`(MangaPlanV2)を表示: カメラ(`shot.size/angle`)・構図・人物(`cast[]`+
  `narrativeGraph.entities` 名前解決)・台詞本文(`panel.dialogueLineIds`→`dialogueSnapshots`)・`promptBase`(折りたたみ)。
- **演出の出所は `directionSource`**(booleanではなく): V2は direction 欠落コマにも既定値を埋めるため
  フィールド欠落では未演出を検知できない。`buildMangaPlanV2` が
  `PanelSpec.directionSource?: "llm" | "fallback" | "human" | "provided"` を残す(additive)。
  UIは LLM演出/未演出/人間修正/Provided をバッジ表示し、人間が編集したコマは `human` へ更新される。
- **編集はホワイトリスト差分で送る**(完全なV2の送り返しはやめる): ライブ更新+エージェント併走の環境で
  クライアント保持の古いV2全体を送ると dialogueSnapshots/layoutSnapshot/provenance まで lost update するため、
  スタジオ用に**専用エンドポイント**を新設する(既存 `PATCH /api/script-manga-plans/:planId` は successor/provided 系
  ツールが完全V2形式で使うため**バイト単位で無変更**のまま残す — 同一ルートでのpayload形状判別は `plan` と `edits` の
  同時指定などの曖昧ケースを生むため分離):
  ```http
  POST /api/script-manga-plans/:planId/edits
  ```
  ```ts
  interface NamePlanEditRequest {
    expectedVersion: number;   // script_manga_plans に edit_version を追加
    edits: Array<
      | { kind: "page";  pageIndex: number; pageIntent: string }
      | { kind: "panel"; panelId: string; shotSize?; shotAngle?; compositionIntent?; promptBase? }
      | { kind: "cast";  panelId: string; characterId: string; expression?; action? }>;
  }
  ```
  サーバーが保存済みplanへホワイトリスト適用→prompt再コンパイル→validation→materialize(同期)→version更新。
  **`edit_version` は「plan_json への全書き込み」で加算する**(本エンドポイント・完全V2 PATCH・materializeRun・
  successor完了 — PATCHハンドラ内だけの加算だと approve→materialize 経由の書き換えで「内容を識別しないversion」に
  なる)。成功応答は materialize 後のversionと正規化済みplanを返す。
  409(approved/running/awaiting_review、またはversionずれ)で読み取り専用/リロード、422はドラフト保持。
- 編集フォームの値は常に `nameStudioDraft` からレンダー(domMorphのフォーカス保護は1要素のみ)。

### D7. ライブ更新と人間ゲート(Plan-NameReaderUI.md D2/D3を吸収)

- script画面ポーリング(既定5秒、`document.hidden` skip、serialガード、busy中の応答破棄、run未保持なら adopted 候補の
  `adoptedRunId` からブートストラップ)。
- Project一覧も5秒(バックグラウンド20秒)で最新のactive候補／run状態だけを軽量更新し、カードの
  「進捗を開く」からproject/script/revision/candidateまたはrun/planを固定したScript URLへ移動する。
- 共有手順(5177は既定で全interface bind済み / 5199は `HOST=` 指定)と、エージェントの待ち合わせプロトコル
  (前提チェック: template作成済み+reference set承認済み → 候補POST → URL案内 → 一覧GETポーリングで
  `status==="adopted"` 検知・adoptedRunId即記録 → run GETで `approved` 待ち → start)を
  Reference-ScriptMangaAgentWorkflow.md / Reference-AgentInstanceApi.md へ追記。

## 互換範囲(「後方互換なし」の明示)

| データ | V5での扱い |
| --- | --- |
| 旧プラン候補(importance/desiredScale形式) | 起動時migrationで一括archive(未決#4。最低でも劣化表示+採用409) |
| 旧・未承認draft plan | 再生成を要求 |
| 旧completed run | 閲覧・export可能(無変更経路) |
| 旧awaiting_review run | review可能(無変更経路) |
| 旧runの resume/repair | **維持**。読み込み境界の `normalizeLegacyVisualScale` adapter 1箇所で吸収 |
| 旧runからの successor | fingerprint不一致による画像再生成を**許容**(継承なしで動作は正常) |
| ビート注釈キャッシュ | `beat-annotator-v2` bumpで自然無効化(再注釈) |

## 実装フェーズ

レビュー指摘によりP1を3分割(各段階で回帰位置を特定できるようにする)。

| フェーズ | 内容 | 主対象 | 規模 | 依存 |
| --- | --- | --- | --- | --- |
| P1a | D1(**additive-only**): 新語彙を旧語彙と**並行導入** — `MangaVisualScale`/`preferredScale`/`derivePanelVisualScale`+hard規則、annotator v2、3境界adapter、provided validator両語彙受理、旧候補archive migration。N1出力境界に hero→large / normal→medium シム。**旧enum・旧フィールド・旧N1はまだ生かす**(旧N1が `importance` を書き、layoutPresets/監督検証が読むため、この段階で消すとP1b/P1c/P2対象ファイルまで壊れる) | `preLayoutBeat.ts` `scriptBeatAnnotator.ts` `mangaPlanV2.ts` `scriptMangaPlan.ts` `scriptMangaPlanV2.ts` `scriptMangaProvidedPlan.ts` `pageLayoutSvg.ts` | 中〜大 | なし |
| P1b | D2: `packAnnotatedBeatsDeterministically` 新設(充足保証・units由来既定値込み)・フォールバック経路差し替え・従来N1削除(X1)・mode二値化 | `scriptMangaPageNaming.ts` `scriptMangaDirector.ts` | 中 | P1a |
| P1c | X3+X2完了: 監督schemaから `layoutTemplateId` 削除・allowedLayouts/layoutGuide削除・`lockLayouts` 削除・**旧enum `MangaPanelImportance` と旧フィールドの削除**(旧N1が消えた後なので安全) | `scriptMangaDirector.ts` `mangaPlanV2.ts` ほかシム除去 | 小〜中 | P1b |
| P2 | D3: layoutFeatures・TextDemand・PanelDemand・実現可能性ゲート・rankLayouts+selectDiverseLayouts(構造化reasons/costs)+X4置換 | `layoutFeatures.ts`(新) `layoutMatcher.ts`(新) `layoutPresets.ts` `scriptMangaPageNaming.ts` | 中〜大 | P1 |
| P3 | D4(決定ゲート): **P3a** 手書きプリセット~10種(4〜6コマの薄い行) / **P3b(条件付き)** 再帰分割カタログ+`gen:v1:` 正規化ハッシュ+バージョンprovenance+リゾルバ拡張 | P3a: `layoutPresets.ts` のみ / P3b: `generatedLayoutCatalog.ts`(新)ほか | 小(P3a)/中(P3b) | P2+P4の計測後 |
| P4 | D5+D7: ネームスタジオ(テイク・リーダー・フリップ=layout overrides+set-layout API・ポーリング)+設定スリム化(X5,X6) | `nameStudioView.ts`(新) `nameStudioController.ts`(新) `name-studio.css`(新) `scriptView.ts` `appState.ts` `main.ts` `scriptMangaPlanCandidates.ts` `db.ts`(2列追加) `index.ts` | **大** | P2(フリップ)。P3無しでも既存プールで動く |
| P5 | D6: 演出ネーム閲覧+差分編集エンドポイント(`/edits`)+`directionSource` | `nameStudioView.ts` `scriptMangaPlanV2.ts` `scriptManga.ts` `index.ts` `db.ts`(edit_version) | 中 | P4 |
| P6 | D7後半: 共有/人間ゲートのドキュメント | `Docs/Reference-*.md` | 小 | なし(いつでも) |

推奨着手順: **P1a → P1b → P1c → P2 → P4(スタジオ) → 計測 → P3a → (指標が不足なら) P3b → P5 → P6**(P5はP4直後でも可)。
カタログ(P3)より先にスタジオ(P4)を出すのは、フリップUIは既存21プリセット+取り込みテンプレでも成立し
(コマ数3は8種あり体験検証に十分。5/6コマは各2種と薄いことが体感できる)、人間が「候補プールの薄さ」を
体感してから投資規模を決められるため。第一手は常に手書きプリセット追加(一晩・新機構ゼロ)で、
ジェネレータとそのバージョン機構は多様性指標がそれでも満たせない場合の最終手段。

## 変えないこと

- 全台詞を一度ずつ必ず割り当てる契約と決定的検証(全経路)
- LLM障害時に生成が止まらない不変条件(fallbackビート+決定的ビートパッカーが引き継ぐ)
- `planningMode:"provided"`・successor/repair パイプライン・`planScriptManga` の残置(削除台帳の「地雷」参照)
- 候補採用の最終決定は常に人間(自動化は推薦まで)。candidateSelectionPolicy="review" 固定
- 台詞本文を画像プロンプトへ入れない
- `plannerProvenance` による全LLM往復の保存(+新規にcatalog/matcher/demandバージョンを追加)
- ポート5177の予約ルール(検証は preview_start の autoPort)
- レイアウトテンプレ規格 v0.3 と取り込みテンプレの候補参加(生成カタログは規格の外側の内部実装)

## 未決事項

1. **TextDemand係数** — 仮: `estimateMinimumPanelArea = f(totalCharacters, balloonCount, writingMode)` の初期式。
   fixture集(検証節)で較正
2. **small の重み(0.6)と検索上の意味** — smallをどこまで積極的に小スロットへ誘導するか
3. **derivePanelVisualScale のソフト規則** — reveal引き上げ/pause縮小を初期実装に含めるか
4. **旧フォーマット候補の扱い** — 起動時migrationで一括archive(推奨)か、劣化表示+採用409のみか
5. **採用前候補に layoutSnapshot まで持たせるか** — P3b(ジェネレータ)を作る場合のみ論点になる。catalogVersion固定+
   採用409で最小限は守れる。set-layout時にsnapshot保存ならバージョン機構ごと不要になるが基礎プラン側の `gen:` 参照は残る
6. **script画面まるごとの三ペイン化** — 今回はスタジオを候補カード位置への置換に留める。マスク編集遷移
   (`state.detail` が画面を奪う)も初期は許容
7. **heuristic をAPIからも消すか** — UIのみ削除を推奨(API値はテスト・外部スクリプトが使うため残置が安い)
8. **ページ列DPによるレイアウト系列最適化** — 前ページのみ考慮で開始し、品質差を見て導入
9. **大/中/小の面積閾値・ポーリング間隔・RTLキー割当** — Plan-NameReaderUI.md の未決を引き継ぎ

## 検証

- 各フェーズ完了時: `bun run typecheck`、`bun test`、`bun run check`
- P1a〜c: enum移行の網羅(~17テストファイル)、`derivePanelVisualScale` のhard規則、二段フォールバック
  (ビートN1失敗→ビートパッカー。**ビート情報が保持されること**)、`beat-annotator-v2` bump、監督schema縮小後のバッチ検証、
  provided/successor 回帰(scriptManga.test.ts の~17件が無傷で通ること)、`normalizeLegacyVisualScale`
- P2/P3: rankLayoutsの決定性・costs内訳・構造化reasons、実現可能性ゲート(不成立ページのreject)、
  selectDiverseLayoutsの類似度間引き、カタログの正規化ハッシュ安定性・dedupe・全件 bleedOvershoot/規約準拠スナップショット、
  `gen:v1:` 解決がクライアント/サーバーでバイト同一、catalogVersion不一致の採用409
- P4/P5: スタジオrenderスナップショット(構造/演出、決定的候補の劣化、`directionSource` 別バッジ)、
  set-layout API(expectedVersion楽観ロック・409系・override適用とリセット・**採用中(adopting)ウィンドウでの
  フリップ拒否**)、`/edits` エンドポイント(ホワイトリスト外フィールド不変・lost update防止・全書き込み経路での
  edit_version加算)、パッカー充足保証(単独超過unit・ビート連続分割・空units)、ポーリングガード
- **fixture集**(ALICE一作品への過適合を防ぐ): `fixtures/name-studio/` に dialogue-heavy / silent-action /
  reveal-page-turn / one-person-monologue / four-speaker-scene / montage / dense-six-panel / quiet-pause の
  Fountainを置き、期待値は「唯一の正解」ではなく**不変条件**で書く(revealが小スロットに置かれない / 台詞容量違反なし /
  splash単独 / 同一レイアウト3連続なし / top-3が別ファミリー / 全台詞一度ずつ)
- 実機A/B(ALICE E01 `pageLimit:5`)+運用指標: hard violation率 / top-3視覚類似度 / フリップ率(初期案から変更した率) /
  選ばれた候補の順位分布 / 同一レイアウト連続率 / レイアウト選択後のpreflight失敗率 / 採用までの時間 /
  未演出fallback率 / 人間によるpanel修正率
- エージェント併走リハーサル: 5199+`HOST=`共有 → APIで候補投入 → ブラウザでライブ到着・フリップ・採用 →
  エージェントが adopted/approved を拾って start まで

## 変更履歴

- 2026-07-16: 人間ゲートの可読性を実装仕様へ反映。コマ内にカメラ・見せる内容・台詞本文を濃色で表示し、小コマはhover/focus詳細、クリックは読取専用ポップアップとした。制作エージェントの通常操作はCLI、GUIは人間ゲートに分離し、Project一覧にも最新候補/run状態と固定コンテキスト導線を追加した。
- 2026-07-16: コード突き合わせ検証(2並列)の指摘を反映。**blocker**: 最終フォールバックのパッカーが充足不能になる
  入力(単独で文字cap超の台詞unit / capを超えるunit数のビート / cap可変×注釈キャッシュ)が存在した → D2に充足保証
  (単独超過unit例外・ビート連続分割・ページ数バンド適用除外・units由来既定値)を明文化。**major**: provided入力境界の
  旧語彙受理(adapter 3箇所化)、P1aのadditive-only化(旧enum削除はP1cへ)、採用×フリップ競合(`adopting` 状態+
  expectedVersion)。**minor**: 候補ビューへ layoutOverrides/editVersion 追加、差分編集を専用 `/edits` エンドポイントへ
  分離+edit_versionの加算規則、D4を決定ゲート化(第一手=手書きプリセット~10種、ジェネレータは指標不足時のみ)、
  X1/X3の影響範囲精密化、空units注記。
- 2026-07-16: 第3者レビューを反映。(1) 決定的フォールバックを `planScriptManga` から**注釈済みビートを入力にする**
  `packAnnotatedBeatsDeterministically` へ変更(ビート情報がフォールバックで失われる矛盾の解消)、
  (2) ビート `preferredScale`/コマ `visualScale` のフィールド名分離+`derivePanelVisualScale` 純関数+hard規則、
  (3) N1受理前の**実現可能性ゲート**追加とhard/soft分離、(4) role要求の必須/希望分離、(5) candidateの基礎プランを
  不変化し **layout overrides+edit_version** 方式へ、(6) `gen:v1:<正規化ハッシュ>`+catalog/matcher/demandバージョンの
  provenance固定、(7) diverse top-k・構造化reasons/costs・TextDemand、(8) 演出編集を**ホワイトリスト差分PATCH**へ、
  (9) `directed?:boolean`→`directionSource`、(10) P1の3分割、(11) 互換範囲表と `normalizeLegacyVisualScale`、
  (12) fixture集と運用指標。ページ列DP最適化は未決#8として保留。
- 2026-07-16: 初版。「互換性なくていいのでシンプルですごいプロダクトを」というユーザー指示を受け、保守版
  [Plan-NameReaderUI.md](Plan-NameReaderUI.md) を置換する形で起票。削除台帳(X1〜X6)と地雷(provided/planScriptManga等)は
  コードベース調査(3並列)で確定済み。
