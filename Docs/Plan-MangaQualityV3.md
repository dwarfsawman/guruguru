# Plan: 漫画品質V3 — Fountain→商業品質漫画の強化計画

> 状態: P1実装中(2026-07-12)。ネーム規格v3.0 validator、SDXL ARバケット/Chroma clamp、方言別conditioning、negative移送、外見タグ注入を実装済み。workflow templateの編集可能メタデータ化と実機画像A/Bは未完了。

## 目的

「Fountain脚本を入力すると、自動コマ割り・コマ別画像生成・セリフ配置まで行い、商業品質の漫画ページを完成させる」というゴールに対し、現行パイプライン(MangaPlanV2 + LLMネーム監督 + 自動吹き出し + VLM監査)の出力品質を阻害している要因を欠陥台帳として固定し、修正フェーズと**ネーム規格v3(LLM監督が満たすべき入出力契約の改訂)**を定義する。

前提となる現行仕様は [Feature-MangaPlanV2.md](Feature-MangaPlanV2.md) と [Done/Feature-AutomaticScriptManga.md](Done/Feature-AutomaticScriptManga.md) を正とする。

## 現状(調査結果)

### 実機出力の欠陥台帳(ALICE E01 冒頭5ページ)

| # | 症状(観測ページ) | 根本原因 → 詳細は次節 |
| --- | --- | --- |
| A | 主人公の髪色・造形が毎コマ別人(p2銀髪→p3黒髪→p4銀髪、p3-1は別デザインの仮面) | C1: 同一性の条件付けが実質プロンプト任せ |
| B | 崩壊した抽象画像のコマ(p1-3、p3-2、p5-2) | C2: パネル縦横比がモデル学習分布外 / C3: 指示文がタグ系モデルに不適合 |
| C | パレット・照明・セットがコマ毎に断絶(同一シーンのコックピットが毎回別物) | C4: シーン単位の固定票が無い + seedランダム + 監督バッチ分断 |
| D | 話者の異なる2つの風船が同型楕円で、読み順も脚本と逆(p2-3「命令だ！」「できない。」) | C5: 風船種別マッピング不在 + 同一コマ内配置順の不具合疑い |
| E | モニター文字《同期率 98.7%》が通常セリフ風船・数字が1文字ずつ縦積み | C5: semanticKind分類の粒度不足 + 縦中横なし |
| F | 「あな/た」「アリス・キ/サラギ」の語中改行 | C6: 折返しが文字貪欲+禁則のみ(文節非考慮) |
| G | 状況説明(西暦二二〇七年…)が誌面に出ない / 1風船に3文詰め込み(p2-1) | C7: `dialoguePolicy: preserve` のみ実装 |
| H | 効果音・集中線・スピード線が皆無で「静止画の連続」に見える | C8: SFX描き文字・効果線レイヤーが存在しない |

### 根本原因

- **C1 同一性**: 顔参照(PuLID)とLoRAチェーンはChroma系workflow専用(`src/server/workflowFeatureFragments.ts`、UNETLoader→LoRA→PuLID→AuraFlow)。SDXL系checkpointのrunでは`reference.face`もLoRAも適用されない。さらにLLM監督モードのprompt compiler(`src/server/panelPromptCompiler.ts` の `english-directed` 分岐)は**castの名前・外見説明を注入しない**(「character in the upper-left region」とだけ言う)。外見の一貫性は「LLMが毎コマprompt欄へ髪型・服装を書き写すこと」への信頼のみで成立しており、書き漏れたコマから別人化する。
- **C2 パネルAR**: `src/server/scriptManga.ts` の `panelGenerationSize` はパネルの縦横比そのまま(長辺既定1024・64丸め)で生成する。縦長ヒーローコマは w/h≈0.33(≈320×1024)になり、SDXL系の学習バケット(0.57〜1.75)を大きく外れて崩壊画像を再現する。横長ワイドコマ(≈2.4)も同様。
- **C3 プロンプト方言**: `compiledPrompt` は自然英文で、`must not show: X` などの**否定指示文をpositive conditioningへ注入**する。CLIP系(SDXL/Animagine)は否定を理解せず、Xのトークンはむしろ描画方向に働く。75トークン毎のchunk分割で後半の効きも薄まる。negative promptは全モデル共通の固定文(`scriptManga.ts` 内)で、タグ系checkpoint推奨のquality tags(positive/negative)も無い。
- **C4 大域一貫性**: LLM監督は4ページバッチ毎に独立呼び出し(`src/server/scriptMangaDirector.ts`)。characterBibleは再注入されるが、**ロケーションの固定票(セット・照明・パレット)が無く**、前バッチの演出も知らない。
- **C5 セリフ種別**: semanticKindの導出は `(M)`/`(N)`/`SFX:` 規約のみ(`src/server/scripts.ts` の `resolveSemanticKindAndText`)。`（通信）``（V.O.）``（記憶）``機械音声` 等はすべて素の `dialogue` になり、楕円風船+口元アンカー対象になる。風船形状も `ellipse | thought | compound` の3種のみ(`src/shared/pageObjects.ts` の `BalloonShape`)。
- **C6 文字組**: `src/shared/textLayout.ts` の `wrapParagraph` は文字単位貪欲+禁則(追い込み/追い出し)のみ。文節境界の考慮なし。縦書きの半角英数字は1文字ずつ正立縦積みで、縦中横(2〜3桁数字の1マス横組み)が無い。
- **C7 セリフ生成**: `dialoguePolicy` は `preserve` のみ受理(`adapt | fill | generate` は400)。脚本セリフの漫画文法化(呼吸単位の分割)、状況説明のナレーションキャプション化、モニター文字のUI表示化がすべて不可能。
- **C8 仕上げ要素**: SFX描き文字のレンダリング様式・効果線(集中線/スピード線)のオーバーレイが機能として存在しない(レイアウト層に `sfx` kindはある)。

## 設計

### D1. 生成条件付けの強化

1. **ARバケットclamp+クロップ割当**(`panelGenerationSize` v2)
   - workflow template のモデル族に応じたバケット表を持つ。SDXL系は標準9種: 1024×1024 / 1152×896 / 896×1152 / 1216×832 / 832×1216 / 1344×768 / 768×1344 / 1536×640 / 640×1536。Chroma系は現行の自由AR+64丸めを維持しつつ w/h を [0.5, 2.0] にclamp。
   - パネルARに対し log(AR) 最近傍のバケットで生成し、割当時に既存 `PanelCrop`(パン/拡縮)を自動設定して**中央クロップでパネルを完全被覆**する。
   - メタデータゲート(aspectRatioDelta 8%)の期待値は「パネルAR」から「選択バケットAR」へ変更。
2. **モデル方言コンパイラ**(promptCompilerVersion v3)
   - workflow template メタデータに `promptDialect: "natural" | "tags"`、`qualityTags`、`negativeBase` を追加(checkpoint名パターンから初期値を推定、テンプレ登録時に編集可)。
   - `tags` ターゲットでは構造化フィールドから直接タグ列を組む: cast数(`1girl`/`2girls`/`1boy`…)→人物毎の外見タグ(D1-3)→shot/angleタグ→action/expression短句→シーンタグ(D1-4)→styleタグ→末尾quality tags。自然文の指示語(「must show:」「leave ... quiet」)は出力しない。
   - `mustNotShow`(および ネーム規格v3の `avoid`)は**positiveに入れずnegative promptへ移送**。negative = negativeBase(モデル族既定) + 移送分 + 偽文字対策(現行文言を継承)。
   - CLIPの75トークン予算を管理し、超過時は quality > 同一性 > shot > action > setting > composition の優先度で後方からドロップする。
   - `natural`(Chroma/T5系)は現行の英文コンパイルを維持(mustNotShowのnegative移送だけは共通適用)。
3. **外見トークンの決定的注入**
   - characterBible を構造化(後述のネーム規格v3参照)し、コンパイラが**毎コマ、castに一致する人物の外見タグを決定的に付加**する。LLMの転記への信頼をやめる。variant(幼少期等)は `PanelSpec.cast[].variantId` で選ぶ。
4. **シーンバイブル**
   - `settingId` 毎に `{ set, lighting, palette }` の英語固定票を planning 時に一度だけ生成(LLM、またはユーザー支給)し、同一シーンの全コマへ決定的に付加+監督入力にも渡す。プランJSONの `narrativeGraph.worldStates` 相当に保存し、provenanceへ固定する。
5. seedは現行のランダム維持(良candidateの選別は人間review+P5の自動ゲートが担う)。

### D2. ネーム規格v3(LLM監督契約の変更) ← 本計画の中心

#### 現行規格(v2)の要約

- 入力: 4ページ毎のバッチ。ページ={index, title, allowedLayouts, panels:[{id, scene, source}]}。characterBible(自由文)はsystem promptへ再注入。
- 出力: `{pages:[{index, layoutTemplateId, pageIntent, panels:[{id, shot, subject, action, emotion, composition, prompt}]}]}`。全フィールド**自由英文の非空文字列**。ページ数・index・panel id・コマ数は変更禁止。layoutは候補内。
- 後処理: `prompt = stylePrompt + LLMのprompt + 固定サフィックス` を連結して `promptBase` とし、コンパイラが shot/cast情報を追記。

#### v3.0 での変更点(フェーズP1)

| 項目 | v2 | v3.0 | 検証(決定的validator) |
| --- | --- | --- | --- |
| `shot` | 自由文 | **enum固定**: `extreme-wide / wide / full / medium / bust / close-up / extreme-close-up / insert` | enum非一致は再生成 |
| `angle` | (shotに混在) | **独立必須フィールド**: `eye-level / low / high / overhead / dutch / pov` | 同上 |
| `subject`(自由文) | 主役の説明文 | **`subjects[]` へ置換**。正準エンティティ参照+9分割配置+動作+表情+視線: `{ref, position, action, expression, gaze?}`。`ref` はcharacterBible/NarrativeGraphの名前に一致必須。無人コマは空配列可 | `ref` がentity解決できなければ再生成。`position` は9値enum(`upper/middle/lower × left/center/right`)→bboxプリセットへ写像し `PanelSpec.cast[].bbox` を埋める |
| `prompt` | 画面の全要素を自由記述(外見・画風も) | **コマ固有の視覚要素のみ**(被写体の状態・背景・光・小道具)。**禁止**: 外見固定属性(髪色・瞳・服 — bibleが注入)、画風語(styleが注入)、否定表現(`no / not / without / never`)、台詞本文、非英語文字 | 否定語・日本語文字は機械的にreject。bible固定属性との重複はwarning |
| `avoid` | (なし) | **新設(任意)**: 誤描画されやすい要素を英語名詞句で列挙(例: `["intact right arm", "crowd"]`)→ negative promptへ移送 | 各要素≤6語、最大8件 |
| 入力: characterBible | 自由文1blob | **構造化必須**: 人物毎に `{name, aliases, english, tags, variants:[{id, when, tags}]}`。`tags` はタグ形式の英語外見(例: `"silver grey short hair, blue eyes, black leather jacket"`) | plan作成時にschema検証。全 `subjects[].ref` / castと突合 |
| 入力: sceneBibles | (なし) | **新設**: settingId毎の `{set, lighting, palette}` 英語固定票。監督は矛盾禁止 | 監督出力がsceneBibleへ言及不要(コンパイラが決定的付加)なので検証は矛盾warningのみ |
| 入力: panels[].dialogues | (sourceに混在) | **新設**: `[{speaker, semanticKind, balloonStyle, chars}]`。文字量から文字用余白(textSafeZones)を計画させる材料 | — |
| 入力: previousPageIntents | (なし) | **新設**: 直前バッチの pageIntent 一覧を渡し、画角リズム・演出の通し一貫性を持たせる | — |
| 後処理 | style+prompt+サフィックス連結 | 連結を廃止。監督の `prompt` は `promptBase` として原文保存し、**組み立てはコンパイラ(方言別)が全面所有** | preflightの台詞漏れ検査は継続 |

不変のまま維持する契約: ページ数・index・panel id・コマ数の変更禁止 / layoutTemplateId はallowedLayouts内 / 全出力英語 / 台詞本文の転記禁止 / 決定的プランナーへのフォールバック / provenance(model・messages・rawOutput)保存。

`DirectedPanel` → `PanelSpec` の写像は既存フィールドで受ける(`subjects[]`→`cast[]`(bbox/expression/action/gazeTarget)、`angle`→`shot.angle`、`avoid`→`mustNotShow`)。**`validateMangaPlanV2` のJSON契約自体は変更しない**(mustNotShowの消費先がnegativeに変わるだけ)。

##### v3.0 出力スキーマ例

```jsonc
{
  "pages": [
    {
      "index": 12,
      "layoutTemplateId": "builtin:right-hero-3",
      "pageIntent": "Alice discovers WHITE RABBIT; awe rises toward the page-turn",
      "panels": [
        {
          "id": "panel-1",
          "shot": "close-up",
          "angle": "low",
          "subjects": [
            {
              "ref": "アリス・キサラギ",
              "position": "middle-center",
              "action": "looking up, gripping the railing",
              "expression": "awed",
              "gaze": "toward the mech head"
            }
          ],
          "action": "Alice looks up at the sleeping mech",
          "emotion": "awe and hesitation",
          "composition": "low angle, mech towering over the frame top",
          "prompt": "a giant white humanoid mech kneeling in a dark flooded hangar, faint blue eye glow, dust and falling water droplets, dramatic rim light",
          "avoid": ["crowd", "daylight"]
        }
      ]
    }
  ]
}
```

#### v3.1 での変更点(フェーズP4: ページネーム段階とセリフ適応)

v3.0 は「ページ/コマ数は監督が変更できない」を維持するが、ペース配分(2.7コマ/頁・ほぼ1セリフ=1コマ、見せ場の大ゴマ不在)は決定的パッカーの限界であるため、v3.1 で**ネーム段階を2段に分離**する。

1. **N1 ページネーム(ペース配分)** — 新設のLLMステージ
   - 入力: シーン/ビート列(全source element)、セリフunit列(N1.5参照)、`targetPageCount`、重要度指針(クライマックス・引きの候補)。
   - 出力: `{pages:[{index, pageIntent, turnHook?, panels:[{id, importance, sourceElementIds, dialogueUnitIds}]}]}`
     - `importance`: `splash / hero / normal`(splashは1ページ1コマ、heroはレイアウト内最大コマへ割当)
     - `turnHook`: ページ末コマに引き(page-turn)を置いたか(`reveal / cliffhanger / none`)
   - 決定的検証: 全source elementが順序保存で被覆・重複なし / セリフunitが読書順単調で全消化・一度ずつ / コマがシーン境界を跨がない / コマ数1〜6かつimportance構成に合うlayout候補が存在 / 総ページ数がtarget±20%。
   - N1の結果に対して現行のページ内演出(v3.0監督)を適用する。既存の決定的パッカーはN1失敗時のフォールバックとして残す。
2. **N1.5 セリフ適応(dialoguePolicy の実装)**
   - `adapt`(v3.1では**分割のみ**): 1発話を呼吸単位のunitへ分割(句読点・文節境界のみ、字句改変なし)。検証=unit連結が正規化後の原文と完全一致。1unit≤30文字目安。「私が止めなきゃ、/みんな死ぬ。」のような複数風船化と、p2-1の3文詰め込み解消が目的。字句を改変する adapt は類似度ゲートを設計してからの将来フェーズ。
   - `fill`: (a)**決定的抽出**: action行中の《…》→ `monitor` unit、scene heading→場所/時刻キャプションunit。(b)LLM補筆(任意ON): 世界観ナレーション(`sourceElementId` の引用必須、1ページ≤2、≤40文字)。
   - SFX起こし: action行(爆発。砲撃。等)から `{text, intensity, placement}` を提案(LLM)。描き文字レンダリングはD6。
   - unitは `{id, sourceLineId | sourceElementId, part/of, text, semanticKind, balloonStyle}` で、既存の「全台詞一度だけ割当」検証は「全unit一度だけ+sourceLine単位で全消化」へ拡張する。

### D3. セリフ種別と文字組

1. **balloonStyle の導出**(scriptインポート時に `dialogue_lines` へ列追加、semanticKindの4値は不変)

| 判定パターン(speaker名/parenthetical) | semanticKind | balloonStyle | 尻尾/顔アンカー |
| --- | --- | --- | --- |
| 既定 | dialogue | `normal`(楕円) | 口元アンカー(現行) |
| `（通信）（無線）（拡声）（スピーカー）` | dialogue | `telecom`(ギザギザ) | 尻尾なし・アンカー除外 |
| speaker名が `機械音声/システム/アナウンス` 等、または本文全体が《…》 | dialogue | `machine`(角丸矩形) | なし |
| `（V.O.）（記憶）（記録）（回想）` | dialogue | `vo`(細枠キャプション) | なし |
| `(M)` | monologue | `thought`(既存) | 泡点(既存) |
| `(N)` / fillナレーション | narration | `caption`(矩形箱) | なし |
| `SFX:` / fill SFX | sfx | 描き文字(D6) | — |
| fill monitor(《…》) | narration | `monitor`(UI風角枠) | なし |

   - ALICE E01 の実在話者(`男の声（通信）/ゲン（通信）/ミラ（V.O.）/シドウ（記録）/AEGIS兵（拡声）/機械音声`)をfixtureにする。
   - `telecom / vo / machine / monitor` はアニメ顔口元アンカーの対象外とし、prompt compiler の speechAct を「off-screen voice; the speaker is not depicted in this panel」へ切替(コマ内に話者の顔を無理に出させない — p2-1で通信の声にドア前の人影が生成された症状の解消)。
   - `src/shared/balloonShape.ts` に `spike`(ギザギザ)/`roundRect`/`caption` パスを追加し、レンダリング(ページSVG・ORA・PPTX書き出し)の全経路で対応する。
2. **縦中横**: 縦書きで `[0-9A-Za-z%.!?]` の連続run(1〜3文字)を1セルに横組み(送り1em、はみ出す場合はem幅へ縮小)。4文字以上は現行(1文字ずつ正立)。`！？`連続も1セル化。`src/shared/textLayout.ts` の `layoutVertical` へ実装し、**事前サイズ計算と実描画の一致**(2026-07-11の教訓)をテストで固定する。
3. **文節折返し**: `wrapParagraph` に折返し候補=文節境界(BudouX等)を導入。幅超過時は直近境界まで戻し(戻り幅が大きすぎる場合のみ文字折返し)、禁則は従来どおり後段適用。「あな/た」「アリス・キ/サラギ」の解消。依存追加の可否は未決事項参照。
4. **同一コマ内の風船順序**: p2-3の読書順逆転(脚本順「できない。」→「命令だ！」が誌面で逆)を再現データで調査し、`dialogueAutoLayout` の同一コマ内順序制約(先の発話ほど右上)を修正またはテストで固定する。

### D4. 同一性スタック(キャラクター/メカの見た目固定)

1. **モデル戦略の一本化(未決事項#1)**: (A) Chroma+PuLID+LoRA(配管済・[Plan-AgentSandboxAndAutoManga.md](Plan-AgentSandboxAndAutoManga.md) の決定と同じ) / (B) SDXL系(AnimagineXL等)+キャラLoRA(+IPAdapter FaceID検討)。どちらでも「`ReferenceManifest` → 生成request」がend-to-endで効く組を1つ確立するのがP2の出口条件。
2. **キャラシート自動生成**: characterBible(v3構造化)から人物毎に表情・角度グリッドのシートを生成する専用run(既存のmanga runと同じ候補review)。採用シートを `character_bindings` へ自動登録し、(A)顔参照+人物LoRA / (B)LoRA学習の教師データ+監査参照に使う。
3. (B)採用時: `workflowFeatureFragments` にSDXL系統(CheckpointLoaderSimple→LoraLoaderチェーン)を追加。LoRA自動学習はsandbox計画(ディスク300GB制約)と合流。
4. **VLM監査の参照強化**: visualIdentity判定へキャラシートを参照画像として渡す(既存 `maxReferenceImages` 0〜6の枠を使用)。

### D5. QAゲートの決定化(MangaPlanV2「未実装・次フェーズ」の具体化)

- 決定的ゲート: (1)顔embedding類似(導入済み anime-face-detector の顔crop→embedding、キャラシート基準・閾値) (2)OCR偽文字検出 (3)崩壊検知(エッジ/彩度統計)。fail時はattempt budget内で**自動リロール**し、尽きたら人間reviewへ(候補は捨てない=現行のfail-open思想を維持)。
- lettering後監査: 風船×顔の重なり率、パネル外はみ出し、本文コントラスト。
- 採用の最終決定が人間であることは変えない。

### D6. 仕上げ要素(SFX・効果線)

- SFX描き文字: ベクター描き文字スタイル(骨格フォント+輪郭/二重縁/変形)を数種プリセット化し、sfx unitの `{text, intensity, placement}` から配置。`semanticKind: "sfx"` のレイアウト経路は既存。
- 効果線: ネーム規格の `composition`/`shot` から機械的に導出できる範囲で、集中線・スピード線・ベタフラッシュのSVGオーバーレイをコマ単位に合成(監督フィールド追加はせず、まず決定的ルールで開始)。

## 実装フェーズ

| フェーズ | 内容 | 主対象 | 規模 |
| --- | --- | --- | --- |
| P1 | D1(ARバケット+クロップ割当/方言コンパイラ/negative移送/外見トークン注入) + ネーム規格v3.0 | `scriptManga.ts` `panelPromptCompiler.ts` `scriptMangaDirector.ts` `scriptMangaPlan.ts` workflow templateメタ | 小〜中 |
| P2 | D4(モデル戦略決定→同一性スタック確立、キャラシートrun、bindings自動登録) + D1-4シーンバイブル | `workflowFeatureFragments.ts` `scriptManga.ts` ほか | 中 |
| P3 | D3(balloonStyle導出+新形状レンダリング/縦中横/文節折返し/風船順序修正/アンカー除外) | `scripts.ts` `balloonShape.ts` `textLayout.ts` `dialogueAutoLayout.ts` 書き出し各経路 | 中 |
| P4 | D2 v3.1(N1ページネーム/N1.5 adapt分割・fill・SFX起こし) + D6 | `scriptMangaDirector.ts` `mangaPlanV2.ts` `scriptMangaPlanV2.ts` ほか | 大 |
| P5 | D5(決定的QAゲート+自動リロール+lettering後監査) | `panelVisualEvaluator.ts` 周辺 | 中 |

P1だけで欠陥A(の大半)・B・Cの改善が見込める。各フェーズ完了時にALICE E01でA/B比較(検証の節)を行い、本ドキュメントへ実機結果を追記する。

## 変えないこと

- 脚本セリフ原文の完全トレーサビリティ(adaptは分割のみから開始し、unit連結=原文一致を検証で保証)
- 台詞本文を画像promptへ入れない(preflight検査を継続)
- immutableなrevision/plan/layout/provenance、run所有物保護、冪等なresume
- 候補採用は常に人間review(自動ゲートはリロールと推薦まで)
- 決定的プランナーのフォールバック(LLM障害時も生成が止まらない)
- Chronicle等の手動編集経路の挙動(fontScale=1のまま)

## 未決事項

1. **モデル戦略**: (A) Chroma+PuLID+LoRA継続 か (B) SDXL系+キャラLoRA新設 か。判断材料: 画風適性(アニメ塗りはB優位)、同一性配管の再利用(A優位)、LoRA学習コスト(Bは学習必須)。P2着手前に1回の比較実験(同一plan・両providerでpageLimit=5)で決める。
2. **文節分割の実装**: BudouX(軽量・MITのTS実装)の依存追加 か、句読点+助詞ヒューリスティックの内製か。
3. ターゲット総ページ数の既定値(N1導入時。24分アニメ脚本≈45ページ前後を想定)。
4. キャラシートの様式(表情差分数・角度数)とLoRA学習の実行環境(sandbox側、ディスク制約)。
5. 効果線オーバーレイを監督フィールドへ昇格させるか(v3.1では決定的ルールのみ)。

## 検証

- 各フェーズで ALICE E01 を `pageLimit: 5` でA/B再生成し、冒頭5ページの欠陥台帳A〜Hを再判定する。P1は同一plan JSONを `planningMode: "provided"` で固定し、コンパイラ/生成サイズ**だけ**を差し替えた画像比較ができる(planの決定はネーム規格v3.0の適用後に再固定)。
- 新規テスト(既存の命名に合わせる):
  - `panelGenerationSize` のバケット選択と `PanelCrop` 自動設定
  - 方言コンパイラのスナップショット(tags/natural、negative移送、トークン予算ドロップ順)
  - characterBible構造化schemaと外見トークン注入(english-directedでcast毎に付くこと)
  - ネーム規格v3 validator(enum・subjects解決・否定語/日本語reject・avoid形式)
  - balloonStyle導出表(ALICE E01の実在話者fixture)とアンカー除外
  - 縦中横・文節折返し(事前サイズ計算=実描画の一致を含む)
  - adapt分割のunit連結一致、fill決定的抽出(《…》/scene heading)
- 完了前に `bun run typecheck`、`bun test`、`bun run check` を実行する(`bun run check` 単独はtypecheck/testを含まない)。

## 変更履歴

- 2026-07-12: P1前半を実装。`panel-prompt-v3.0`、v3監督schema/validator、9分割cast写像、avoid移送、SDXLバケット/Chroma AR clampを追加。指定 `ALICE_REBOOT_E01.fountain` は警告0で16シーン/37ページ/148コマ/233発話として計画できることを確認。
- 2026-07-12: 初版。ALICE E01実機出力の欠陥台帳、根本原因(C1〜C8)、設計(D1〜D6)、ネーム規格v3.0/v3.1、フェーズP1〜P5を起票。
