# Reference: 吹き出し一括配置ソルバー(dialogueAutoLayout)

Chronicle Page Flow(S5、[`Docs/Done/Feature-ChroniclePageFlow.md`](Done/Feature-ChroniclePageFlow.md))の一括配置ソルバー
(`src/shared/dialogueAutoLayout.ts`)の内部仕様。純ロジック(DOM・db 非依存)で、`preview`/`apply`/`reflow` API
(`src/server/dialogueAutoLayoutApi.ts`)から呼ばれる。設計変更・チューニング時はこのファイルを更新すること。

## 1. 入力・出力

```ts
interface DialogueAutoLayoutInput {
  layout: PageLayout;                       // コマ割り(readingDirection・panels)
  existingObjects: readonly PageObject[];    // 障害物(ロック済み balloon を含む)
  items: DialogueAutoLayoutItem[];           // 配置対象の発話(サイズ候補込み)
  seed: number;                              // 決定的探索の種
  avoidZones?: DialogueAvoidZone[];          // 顔・立ち絵の回避領域(page 座標、§5.5)
  maxPanelCoverageRatio?: number;            // コマ専有率上限(§5.5)。未指定=無制限(従来挙動)
}

interface DialogueAutoLayoutItem {
  placementId: string;
  lineId: string;
  text: string;
  semanticKind: DialogueSemanticKind;        // "dialogue" | "monologue" | "narration" | "sfx"
  speakerLabel: string;
  orderIndex: number;                        // dialogue_lines.order_index
  sizeVariants: PageVec[];                   // 縦長優先の順で並んだサイズ候補(サーバー側で算出)
}
```

出力 `DialogueAutoLayoutResult` は `objects`(生成する PageObject 配列)・`assignments`(placementId→panelId/objectId)・
`warnings`・`unplacedPlacementIds`。DB は一切更新しない(呼び出し側=`dialogueAutoLayoutApi.ts` の役目)。

## 2. サイズ計算(サーバー側、`requiredSizeVariantsFor`)

- 各行のテキストを既定バルーンスタイル(`DEFAULT_TEXT_STYLE`、sfx はフォントサイズ `AUTO_LAYOUT_SFX_FONT_SCALE`=2倍)で
  `computeTextLayoutForContent`(`textLayoutApi.ts`、LRU 付き)にかけ、bbox を得る。
- 折返し幅は `estimateWrapWidth`(文字数の平方根に比例、`WRAP_HEIGHT_CAPS = [0.36, 0.28, 0.2]` の3段階の列高さ上限で頭打ち)。
  折返し無し(`maxWidth=undefined`)で呼ぶと縦書きが際限なく伸びるため、必ず上限付きで呼ぶ。
- `CONTENT_PADDING_RATIO` の逆数で「折返し幅→形状サイズ」に換算し、`MIN_BALLOON_WIDTH`/`MIN_BALLOON_HEIGHT`(dialogue/monologue)
  または `PAGE_OBJECT_MIN_SIZE`(sfx)で下限クランプ。
- 3段階の cap から生成した候補を**縦長優先**(cap の大きい順)で並べ、bbox が重複するものは除去する。
- ソルバー(`runDialogueAutoLayout`)は `sizeVariants` を先頭から順に試し、コマに収まる最初の候補を採用する
  (全滅時のみ unplaced)。1件目が横長すぎてコマに入らなくても、2件目以降の縦長候補で収まることがある
  (回帰テスト: `dialogueAutoLayoutApi.test.ts` の four-grid/six-panel ケース)。

## 3. コマ順(reading direction)ソート(`orderPanelsByReadingDirection`)

1. 各コマの中心座標(`panelBounds` の bbox 中心)を求める。
2. y 座標でソートし、「直前行の平均コマ高さの半分以内」を閾値に行(row)へ束ねる(一般的なコマ割りの行検出)。
3. 行内を x でソートする。RTL は降順(右→左)、LTR は昇順(左→右)。

## 4. 発話の文字量比配分(`distributeItemsToPanels`)

- `narration` はコマ非依存(`panelIndex = null`)、それ以外(dialogue/monologue/sfx)を対象にコマへ配分する。
- 重み = `Math.max(1, text.length)`。累積重みの**中点**(足す前の累積と足した後の累積の中間)がどのバケットに
  属するかでコマ index を決める。
  - **既知の不具合(修正済み)**: 「足した後の累積」で判定すると、平均よりわずかに重いだけの先頭行が最初の
    バケット境界を自分の重みだけで越えてしまい、先頭コマが1件も割り当てられないまま丸ごと飛ばされる偏りが
    起きる。中点判定はこれを避ける。
- 結果は `order_index` 昇順を維持したまま `panelIndex`(コマ順の index、reading direction ソート後)を持つ。

## 5. 候補生成・スコアリング(`searchBestCandidate`)

- 対象領域(コマ bbox またはページ全体)に `CANDIDATE_GRID`(6×6)のグリッドで候補点を敷く。
- 各候補は以下を満たさなければ除外(ハード制約):
  - ページ外に出ない(`pageBounds` チェック)。
  - polygon/ellipse コマは中心点が形状の内部にあること(`pointInPanelShape`。rect/path は外接矩形近似)。
  - 既存オブジェクト(`obstacles`、0.006 だけ inflate 済み)と重ならない。
- ソフト制約はスコアに反映(降順ソートし最良を選ぶ):
  - コマ上部優先(`score -= ty * 2`。row=0 が最上段)。
  - reading direction の走査方向(RTL は右寄り、LTR は左寄りを弱く優先)。
  - narration の `avoidPanelBoxes`: コマの上に極力被らないよう減点。
  - 同一話者近接(`anchorHint`、直前に配置したその話者の位置へのボーナス)。
  - サイズが大きいほど微減点(`size.x * size.y * 0.1`)。
- **同点近傍**(`SCORE_EPSILON = 0.09`)は tie として扱い、`random()`(mulberry32、seed 付き)で選ぶ。厳密な浮動小数
  一致だけを同点にすると常に同じ候補が選ばれ、「再配置(seed 変更)」が実質無意味になるため意図的に幅を持たせている。

## 5.5 回避領域とコマ専有率上限(Docs/Reference-MangaCompositions.md)

どちらも**未指定なら従来と完全に同じ経路**(passes=[false] の1周、PRNG 消費列も不変)。指定時は
strict → relax の二段探索になる。

- `avoidZones`: 顔(plan cast bbox の上端 38%)や、ぶち抜き立ち絵(figure スロットの cast 全身)の
  矩形。**strict パス**では重なる候補をハード除外し、**relax パス**では重なり面積比 × 6 のスコア
  減点のみで配置する(上部優先スコアの振れ幅 2 を上回る強さ)。
- `maxPanelCoverageRatio`: コマ外接矩形面積に対する「そのコマの吹き出し/キャプション合計面積」の
  上限(0.05〜1 に clamp)。既存オブジェクト(balloon/box、中心点の属するコマで近似)も算入する。
  strict で超過する配置は候補にせず、非固定アイテムは §6-2 の後続コマフォールバックで逃がす。
  preferredPanelId 固定(自動漫画)のアイテムはコマを移さず relax で同コマに置く。
- relax パスで置いた発話には「顔・立ち絵の回避/コマ専有率の制約を緩和して配置しました」警告が付く。
  unplaced の意味は従来と同じ(relax でも置けない=本当に空きが無い)。
- 自動漫画(`ensureDialogueLettering` と figure 採用後の再レタリング)は常時
  `maxPanelCoverageRatio: 0.45` + plan 由来の avoidZones を渡す。手動 Chronicle UI は未指定のまま。
- HTTP API(preview/apply/reflow)は body の `avoidZones` / `maxPanelCoverageRatio` をそのまま
  受ける(不正形は 400)。reflow は `fontScale` も apply と同じ規約で受け、自動漫画ページの
  再配置時に本文サイズを維持する。

## 6. フォールバック規則

配置できなかった場合、種別ごとに以下の順でフォールバックする(narration は元々ページ全体候補なのでフォールバック不要):

1. **担当コマ内でのサイズバリアント探索**(§2 のとおり、全種別共通)。
2. **後続コマへのフォールバック(dialogue/monologue/sfx 以外の panel ベース種別)**: 担当コマに空きが無い場合、
   発話順とコマ順の単調性(order_index 昇順で panelId のコマ順が逆転しない)を壊さない範囲で後続コマへの配置を
   試みる。探索範囲は「直前に panel ベースで配置した発話のコマ index の次」以降(単調性維持)、かつ「担当
   index + 2」まで(遠すぎるコマへ逃がさない)。**sfx はこのフォールバックの対象外**(次項の専用フォールバックが
   ある)。
   - 導入経緯(フェーズV): 2×2 グリッドで担当コマが他の吹き出し(特にロック済み)で埋まっていると、コマ内探索が
     全滅して seed に関係なく unplaced になる不具合があった。乱数はスコア同点の tie-break にしか使われないため、
     「seed を変えれば直る」という前提が成立しないケースだった。後続コマへ逃がすことで解消する。
   - 回帰テスト: `src/server/dialogueAutoLayoutApi.test.ts`
     「2x2グリッドで5件中1件ロック、ロック吹き出しが担当コマを占有していても後続コマへフォールバックして
     配置できる(回帰)」。
3. **ページ全体フォールバック(sfx のみ)**: 担当コマ内(バリアント全滅)またはコマ自体がゼロの場合、担当コマ
   近傍を優先しつつページ全体(`pageBounds`)から探す。narration と同じ「コマ非依存」枠として `targetPanel = null`
   になる。
4. すべて失敗したら `unplacedPlacementIds` へ積み、種別に応じた warning 文言を付ける
   (「コマに対して文字量が多すぎる」/「空きスペースが見つからない」/「対象コマが見つからない」/
   「このページにコマが無い」/「上限に達している」)。

## 7. オブジェクト id の生成と衝突回避

- `nextObjectId(seed, localIndex) = "autolayout_${seed}_${localIndex}"`。**seed をまたいだグローバルカウンタは
  持たない**(同 seed・同入力なら同じ id 列になることが§8 のテスト対象)。
- **衝突回避(フェーズV で追加)**: `reflow` のように呼び出しごとに毎回 `localIndex=0` から数え直すため、
  `existingObjects`(障害物として渡されるロック済みオブジェクト等)の id と同じ id を新規生成してしまうことが
  ある(特に reflow を同じ seed で複数回叩いた場合)。これを `normalizePageObjects` の重複 id リネーム
  (`_dup` サフィックス)に任せると、ロック済みオブジェクト側が `_dup` へ追いやられて id が変わり、
  `dialogue_placements.balloon_object_id` の参照が浮く重大なバグになる。そのため、ソルバー内で
  `existingObjects` の id 集合(+今回生成済み分)を `usedObjectIds` として保持し、衝突する id が出た場合は
  `localIndex` を進めて空いている id まで探す。この探索も決定的(seed・入力が同じなら毎回同じ結果)。

## 8. 決定性(seed 再現性)

- 乱数は自前の mulberry32 PRNG のみを使い、`Math.random` は使わない。
- 同 seed・同入力(layout・existingObjects・items の内容と順序)なら `objects`/`assignments`/`warnings`/
  `unplacedPlacementIds` を含め完全に同じ結果になる(`dialogueAutoLayout.test.ts` の「同 seed なら同じ結果」
  「バリアント探索でも同じ結果」で検証)。
- 「再配置」操作(reflow)は `seed` を変える(`applyDialogueLayout` は呼び出し元が指定、`reflowDialogueLayout` は
  省略時 `node:crypto` の `randomInt` で新しい seed を1回だけ引く。これはソルバー自体の PRNG 制約
  ―`Math.random` 不使用―とは別の関心事: 「毎回違う seed を選ぶ」ためだけの1回きりの乱数)。

## 9. コマ形状の内部判定

- polygon: ray casting(`pointInPolygon`)。
- ellipse: 正規化距離(`(dx/rx)^2 + (dy/ry)^2 <= 1`)。
- rect/path: 外接矩形での近似(§2.5 は polygon のみ内部判定を明示、という設計書どおり)。

## 10. ハード制約まとめ

- 吹き出し同士・ロック済み/既存オブジェクトと重ねない(0.006 の余白込み)。
- ページ外へ出さない。dialogue/monologue はコマ bounding box 内(+最低余白)。narration/sfx はページ全体候補も許可。
- `PAGE_OBJECTS_MAX_COUNT`(300)超過なら配置不能として扱う(`placedCount` を都度加算してチェック)。
- 同一行への PageObject 重複作成をしない(1発話=1オブジェクト、途中で失敗したら unplaced のまま次の発話へ)。
- コマ順(reading direction)と発話順(order_index)を逆転させない(§4 の配分 + §6-2 のフォールバック範囲制限で担保)。

## 12. MangaPlanV2(script-manga)経路の最小可読サイズ落とし穴

自動漫画の一括レタリング(`ensureDialogueLettering` → `applyDialogueLayoutWithFallback`、
`src/server/scriptManga.ts:344-392`)は、本ファイルのソルバーとは別に**プレースメント後の追加ゲート**
(`requireReadableBalloonText`、`scriptManga.ts:417-441`)を持つ。`planningMode:"provided"` で
1コマに複数の発話(`dialogueOrderIndexes.length >= 2`)を割り当てて手作りすると、ここで
`run` 作成全体が **422「Dialogue does not fit at the minimum readable size (0.016);
split dialogue or re-plan the page: line_...(N chars)」** で失敗することがある。ALICE_REBOOT_E02
の375コマ・provided plan 構築時に実際に踏んだ不具合と、その予測・自動修復手順を記録する。

### 12.1 何が起きているか

1. `applyDialogueLayoutWithFallback` はまずコマ内の全発話を1バッチとして `fontScale=0.88`
   (`SCRIPT_MANGA_FONT_SCALE`、`scriptManga.ts:141`)で16回試す。失敗すると**発話1件ずつ**に切り替え、
   配列順に `[0.88, 0.75, 0.62, 0.5, 0.42, 0.35]` の `fontScale` ラダーを個別に下げながら配置する
   (`scriptManga.ts:369-391`)。
2. 同じコマ内で**先に処理された発話が良い位置/サイズを取り**、後続の発話は残りスペースしか使えない。
   後続発話が `fontScale=0.35` まで落ちることがあり、これは `0.04 * 0.35 = 0.014 < 0.016`
   (`SCRIPT_MANGA_MIN_FONT_SIZE`、`scriptManga.ts:146`)。
3. `requireReadableBalloonText` は `content.style.size < 0.016` のバルーンだけを対象に、
   フォントを強制的に `0.016` へ引き上げて再度収まるか判定する(`scriptManga.ts:424-433`)。
   しかしバルーンの外形は `preserveBalloonFontSize`(常時 true、`panel-prompt-v3.2` 経路)により
   **小さいフォントぴったりの余白ゼロで確定済み**なので、引き上げ後の文字がまず収まらず失敗する。
4. **短い発話ほど安全とは限らない**。縦書きは1コマ内で列高さが文字数にほぼ比例するため
   (`estimateWrapWidth`、`dialogueAutoLayoutApi.ts:183-187`)、7文字程度の短文でも小さいコマ
   (例: `builtin:three-hero-bottom` の setup 枠、0.45×0.43)ではバルーン高さがコマ高さの9割前後に
   達し、先着の発話に押し出されて即座に下限割れする。
5. エラーは**最初に見つかった1件だけ**を報告して run 作成全体を中断する(422、page/panel の特定情報なし)。
   1つの provided plan に同種の違反が複数あっても1回のリクエストでは1件しか分からず、
   「直して再送→次の1件が出る→また直す」を素朴に繰り返すと大きな plan では非現実的な回数になる。

### 12.2 予測・自動修復の手順(このコマンドで再現できる)

`requiredSizeVariantsFor` 相当のサイズ計算(`dialogueAutoLayoutApi.ts:201-237`)は DB 非依存で、
実運用中のサーバーの `POST /api/text-layout`(`src/server/textLayoutApi.ts`)を呼べば実フォントの
正確な bbox が得られる。これを使い、投げる前にローカルで全コマを検査できる。

1. 各発話本文について `POST /api/text-layout` を `WRAP_HEIGHT_CAPS = [0.36, 0.28, 0.2]` の3候補で叩き、
   `requiredSizeVariantsFor` と同じ式(`rawWidth/rawHeight` を `(1 - CONTENT_PADDING_RATIO) * balloonInscribedFactor(shape)`
   で割り、`MIN_BALLOON_WIDTH=0.07`/`MIN_BALLOON_HEIGHT=0.06` で下限クランプ)でバルーンサイズを算出する。
2. 対象コマの実寸(`src/shared/layoutPresets.ts` の各 builtin レイアウトの panel bounds を直接使う。
   `four-grid` は 0.45×0.656044、`three-hero-bottom` の setup 枠は 0.45×0.43 など、レイアウトIDだけでなく
   **スロットごとの実寸**を使わないと過小/過大評価する)に対して、
   - いずれの候補も `width > panelWidth * 0.8` または `height > panelHeight * 0.8`
     (`AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO`、`dialogueAutoLayout.ts:33`)なら**単独でも収まらない**と判定。
   - コマ内の全発話の(収まる候補の中で最小の)面積合計が `panelArea * 0.45`
     (`SCRIPT_MANGA_MAX_BALLOON_COVERAGE`、`scriptManga.ts:151`)を超えるなら**共存で溢れる**と判定。
3. 違反コマは次のいずれかで直す。
   - **coverage 超過**(複数発話が同居): 1発話1コマへ分割し、ページのレイアウトを新しいコマ数の
     既定レイアウトへ差し替える。
   - **単独でも収まらない**: その発話だけを独立した `builtin:splash` ページへ昇格する(最も安全、
     かつ重要な台詞を大ゴマ扱いする演出としても違和感が無い)。
4. 分割/昇格は**新しいレイアウトの空きスロットが元より小さくなる**ことがあるため(例:
   `four-grid` の1コマを割って5コマ化すると `builtin:five-panel` の小枠は `four-grid` の枠より
   低い)、1回の修復で新たな違反が生まれ得る。**予測→修復→再予測を収束(違反0件)するまで反復する**
   (ALICE_REBOOT_E02 では2周で収束)。
5. 分割時は**その1発話だけの sourceText を作り直す**こと。元の複数発話ぶんの `sourceText` を
   そのまま複製すると、他の発話の引用文中に含まれる別キャラクター名まで一緒に複製されてしまい、
   `characterIdsForText`(`src/server/storyGraphBuilder.ts:189-194`、引用文かどうかを区別しない
   単純な部分一致)経由で不在キャラクターが cast に紛れ込む副作用が出る。

### 12.3 既定パイプライン(heuristic/LLM監督)への波及

この最小可読サイズゲートと `fontScale` ラダーはプランニングモードを問わず `materializeRun` から
常に通る(`scriptManga.ts` 内、provided/heuristic/llm 共通)。決定的プランナー(heuristic)は
既定で `panelsPerPage=4`・`maxDialoguesPerPanel=2` かつ常に各コマ数の**先頭候補レイアウト**
(`layoutForPanelCount`、`scriptMangaPlan.ts:106-110`)を選ぶため、上記の「小さいスロットに複数発話」
が起きにくい組み合わせに寄っているだけで、原理的には同じ422を踏み得る。`planningMode:"provided"`
で `builtin:three-hero-bottom`/`builtin:four-hero-bottom`/`builtin:five-panel`/`builtin:six-panel`
のような不均等スロット・小スロットへ複数発話を意図的に置く場合は特に注意する。

## 13. 関連ファイル

- `src/shared/dialogueAutoLayout.ts` … 本体(純ロジック)。
- `src/shared/dialogueAutoLayout.test.ts` … 単体テスト(RTL/LTR・重なり回避・サイズバリアント・
  フォールバック・seed 再現性)。
- `src/server/dialogueAutoLayoutApi.ts` … サイズ計算結線・preview/apply/reflow・トランザクション。
- `src/server/dialogueAutoLayoutApi.test.ts` … API 単位のテスト(ロールバック・上限・ロック除外・
  reflow のフォールバック回帰など)。
- `src/server/scriptManga.ts` … `applyDialogueLayoutWithFallback`/`requireReadableBalloonText`
  (§12 の script-manga 専用ゲート)、`SCRIPT_MANGA_FONT_SCALE`/`SCRIPT_MANGA_MIN_FONT_SIZE`/
  `SCRIPT_MANGA_MAX_BALLOON_COVERAGE` の定数。
- `src/shared/layoutPresets.ts` … builtin レイアウトのスロット実寸(§12.2 の予測に必須)。
