# Script Manga エージェント運用リファレンス

FountainからMangaPlanV2を作り、画像生成・候補採用・書き出しまでを自動化する利用者／コーディングエージェント向けの現行手順である。個別作品の全文prompt、候補画像、制作ログはrepositoryへ保存しない。

## 組み込みモデルと外部エージェントを分ける

ネーム監督・画像監査の担当名はプロバイダ固定値ではない。制作依頼にある`claude`、`codex`、`local llm`などは、ユーザーが`Claude Code CLI`や特定APIを明示しない限り「その役割を担当するエージェント」の指定として扱う。現在のエージェントに視覚入力とサブエージェント機能があるなら、その能力でネーム作成・候補比較・VLM相当の目視監査を行える。担当名が`claude`というだけでClaude Codeを必須にしたり、GURUGURUの接続設定へ自動的に結びつけたりしない。

| 実行主体 | GURUGURU設定 | 接続要件 |
| --- | --- | --- |
| 組み込みLLMによるネーム監督 | `planningMode:"llm"` | `/api/settings/llm`のOpenAI互換接続が必要 |
| Codex／Claude Code／Local LLMなど外部エージェントが作成・修正したネーム | `planningMode:"provided"` | GURUGURUのLLM接続は不要。完全なplan、固定revision、validation、preflightが必要 |
| 組み込みVLM監査 | `auditMode:"vlm"` | `/api/settings/vlm-audit`のLM StudioまたはOpenAI互換接続が必要 |
| 視覚入力を持つ外部エージェントによる候補監査 | `auditMode:"manual"` | GURUGURUのVLM接続は不要。APIの候補画像を明示的に比較し、`audit-results`へ評価証跡を登録してから許可された範囲で`select`する |

`manual`は後方互換のAPI名であり、「組み込みVLMを起動せず明示レビューへ送る」という意味である。レビュー担当は人間に限定されず、制作依頼で許可された外部エージェントでもよい。ネーム候補の採用とrun承認も本質的な人間専用操作ではなく、ユーザーが「Take Aにして」のように現在のエージェントへ選択を委任した場合はCLI/APIで進める。人間専用になるのは、依頼が明示的に人間ゲートを指定した場合、またはエージェントがその判断用`guiUrl`を人間へhandoffした後である。外部エージェント経路を選べる場合、組み込みLLM/VLMの未設定・unreachableだけを理由に制作全体をblockedへ移さない。

外部エージェントが画像を監査するときも、候補は`bun run agent:cli ... api GET ... --output`でGURUGURU APIから取得する。通常の制作操作にブラウザ自動操作やGUIスクリーンショットを使わない。runtime DB/data directory、本番ComfyUIの`/history`・`/view`・入出力ディレクトリへ迂回しない。視覚入力を持たないエージェントしか利用できない場合は、画像監査だけを実施済みと扱わず、視覚対応エージェントまたは人間レビューを再開条件として報告する。

## CLIを制作の正とする

外部エージェントのrun、固定revision、plan、task、候補、Reference Set、ページ、画像、export操作は
`bun run agent:cli`から同一インスタンスのHTTP APIへ行う。GUIは人間ゲートと、ユーザーが明示したUI検証だけに使う。
GUIを日常操作してスクリーンショットから状態を推定する運用は禁止する。

人間へURLを渡す直前に`context`を実行する。CLIは実際のbase URLへ疎通し、project/script/最新固定revisionと
指定candidate/run/plan/taskの所属を照合してから正規`guiUrl`を返す。URLはコピー用fenced code blockへ全文表示する。
ユーザーがChromeを明示しChrome操作が使える場合だけ、同じURLをChromeへnavigation-onlyで開き、以後は操作しない。

```powershell
bun run agent:cli -- --base-url <actual-url> context --project-id <project-id> --script-id <script-id> --candidate-id <candidate-id>
```

CLIとGUIは同じAPIサーバーを使い、正規URLは同じIDを含むため、両者の対応は画面の直前選択状態に依存しない。
人間がbare URLのProject一覧から入った場合も、Bookカードの最新漫画状態と「進捗を開く」が5秒ごとに同期する。
コマンド詳細は`Docs/Reference-AgentInstanceApi.md`を参照する。

### 組み込み／外部経路の自動選択

最初に`route`を実行する。CLIは`/api/llm/status`と`/api/vlm-audit/status`を同時に確認し、組み込みモデルが実際に使える場合だけ`planningMode:"llm"`／`auditMode:"vlm"`を選ぶ。LLMサーバーへ疎通できても設定modelが一覧に無い場合は外部経路へ落とす。VLMのon-demand load可能状態は組み込み経路として扱う。

```powershell
bun run agent:cli -- --base-url <actual-url> route
```

`candidate create`はこの判定を使う。組み込みLLMが使えれば従来の候補生成API、使えなければ固定revisionと外部作成planを候補groupへimportする。同じページ／コマ境界、source element／台詞割当、visualScale、めくりを持つ案は構造重複として同じ候補へupsertされ、A/B/Cの水増しをしない。補助的な`sourceBeatIds`の有無だけでは別案にしない。

```powershell
# 組み込みLLMが使えるときは通常生成。使えない場合、下のrevision/plan指定へ自動で切り替わる
bun run agent:cli -- --base-url <actual-url> candidate create --project-id <project-id> --script-id <script-id> --revision-id <revision-id> --plan-file <plan.json> --profile readability
```

候補を人間またはエージェントへ提示する前に、実際に採用時に使うtemplate、dialogue設定、生成条件を指定してfull preflightを通す。この検査は本番DBの同時書込みと分離したインメモリsnapshot上でV2化、台詞自動配置、最小可読サイズ、全panel deterministic preflightまで実行する。dry-runのrun/page/task/placementは破棄され、report内のそれらのIDは一時IDなので後続APIには使わない。Reference Set、画像生成、画像監査は`skippedChecks`へ明示される。

組み込み候補で監督LLMが全batchを正常完了し、materializeも成功した場合だけ、検査した演出planを本番candidateへ固定する。この成功時は`directorMode:"provided"`となり、`editVersion`が1進み、レイアウトoverrideは実効planへ取り込まれて消える。演出条件はhashへ固定され、後のpreflight/adoptは同じ条件を要求する。検査失敗、監督fallback、LLM未接続ではcandidateを変更せず、監督fallbackは503として外部plan importまたは接続復旧を求める。`ok:false`はexit code 2であり、`issues`を修正して再import・再検査する。

```powershell
bun run agent:cli -- --base-url <actual-url> candidate preflight --candidate-id <candidate-id> --template-id <template-id> --json-file <run-settings.json>
```

ユーザーがエージェントへ採用を委任している場合は、GUIの「この案で生成」を押す必要はない。専用adopt APIは同じ設定でfull preflightを必ず再実行し、失敗時は422の`{error,preflight}`を返して採用しない。成功時は全ページを1つのprepare-only runへ固定し、Reference Set必須・fallback禁止の状態で`adopting`から`adopted`へ遷移する。初回応答は`{candidate,run,preflight}`、同じ採用の再送は既存identityの`{candidate,run}`であり、常に`candidate.adoptedRunId === run.id`を正とする。汎用`POST /api/projects/:id/script-manga-runs`へ`planCandidateId`を渡す迂回経路は拒否される。

```powershell
bun run agent:cli -- --base-url <actual-url> candidate adopt --candidate-id <candidate-id> --template-id <template-id> --json-file <run-settings.json>
```

外部画像監査は候補画像をAPIで取得して視覚確認した後、候補ごとの合否、check、違反、使用model、reviewerを正式記録する。登録応答`{report,run}`で正規化・保存されたreportとtask所属を確認する。明示的にFAILを登録したassetは`manual` runでも`select`できない。監査記録が無いmanual候補の人間選択は後方互換のため許可する。

```powershell
bun run agent:cli -- --base-url <actual-url> audit record --task-id <task-id> --json-file <audit-result.json>
bun run agent:cli -- --base-url <actual-url> api POST /api/script-manga-tasks/<task-id>/select --json '{"assetId":"<asset-id>"}'
```

## 0. ネーム選択の人間ゲート(attended運用、ネームスタジオV5)

エージェントが候補を作り、**人間が localhost のネームスタジオで読んで選ぶと明示された**運用。依頼者が見ていることだけでは人間専用ゲートとはみなさず、現在のエージェントへTake指定があれば前節のCLI採用を使う。人間へ選択をhandoffする場合だけ以下を使う。

```
0. CLIで前提チェック(URL案内より前に確認):
     - workflow template が作成済み(スタジオの採用ボタンは templateId 未設定だと disabled)
1. agent:cliのapiコマンドで POST /api/projects/:id/script-manga-plan-candidates
   {scriptId, count:3, ...}   ← 候補提示
2. agent:cli contextで実インスタンスとID対応を検証し、返されたguiUrlを直ちに人間へ案内
   - コピー用fenced code blockへ正規URLを全文表示する
   - Chromeを明示され、Chrome操作が使える場合は同じURLをChromeへnavigation-onlyで開く
   - 以後エージェントはネームに触らず、`agent:cli wait`を開始せず、そのタスクを終了する
3. 人間が採用後にタスクを明示的に再開した時だけ、候補一覧をAPIで一度取得:
     - candidate.status === "adopted"ならadoptedRunIdを記録して次へ
     - "adopting"または未採用なら、その状態を一度報告して終了する(定期pollしない)
     - 空リスト化・既知候補id消失なら、revisionを一度確認して再提示の要否を報告する
4. adopted runのplanにある実際のvisible castを基準にReference Set候補を作成し、人間へ承認を依頼して終了:
     - Chroma: face
     - Anima: face + full_body
     - ネーム候補の採用自体はReference Set未作成でも成立する
5. 人間がReference Setとrun承認後にタスクを再開した時だけ、GET /api/script-manga-runs/:runId を一度取得:
     - approvalStatus === "approved"なら次へ
     - 未承認なら一度報告して終了する。必須Reference Set不足のapproveは422となり、runはprepared/pendingのまま
6. agent:cli apiで POST /api/script-manga-runs/:runId/start → 以降は既存の生成・レビューフロー
```

pre-approvalのmaterializeは必須Reference Set不足だけを遅延し、plan、cast、台詞、layoutなど他の
validation/preflight errorは従来どおり拒否する。run承認時は承認済みReference Set snapshotを固定し、
そのsnapshotで全taskをstrictに再materializeする。失敗時は承認処理全体をrollbackするため、
候補採用後に実キャストだけのReference Setを整備してから安全にrunを承認できる。

採用runの生成設定(template等)は、採用ボタンを押すブラウザ側の script 画面設定が使われる
(エージェントは手順2の案内時に必要な設定値を人間へ伝える)。候補のページ別レイアウトは
`POST /api/script-manga-plan-candidates/:id/set-layout` (`{pageIndex, layoutTemplateId, expectedVersion}`)
で人間・エージェントのどちらからでも変更でき、`expectedVersion`(候補の `editVersion`)の楽観ロックで
競合を検出する。基礎プラン(`plan`)は不変で、選択は `layoutOverrides` に載る。

人間はさらにスタジオの「✎ コマ割りを修正」で、辺・頂点・交差点・コマ間余白・裁ち切り・吹き出し位置を
ドラッグ修正できる(Docs/Feature-NameGateLayoutEdit.md)。修正は
`POST /api/script-manga-plan-candidates/:id/set-custom-layout`
(`{pageIndex, layout|null, balloonHints|null, expectedVersion}`)で `customLayouts`/`balloonHints` レイヤーへ
保存され、テンプレ選択より優先して採用時の `layoutSnapshot` へ固定される。同ページの set-layout フリップは
修正を破棄する。「このネームで生成」(旧「この案で生成」)は修正込みの実効プランで full preflight を再実行し、
通過した場合だけ run を作る。エージェントは人間の修正済み候補を通常どおり adopted 検知して続行すればよい。

V5の語彙変更: コマの重みは `visualScale`(`small/medium/large/splash`)。provided plan では旧
`importance`(`splash/hero/normal`)も引き続き受理され `visualScale` へ写像されるが、新規は
`visualScale` を使う。ネーム監督はレイアウトを選ばない(`layoutTemplateId` は監督schemaから削除済み。
provided/候補のレイアウトがそのまま使われる)。

テイクA/B/Cは主にbeatの束ね方・コマ境界・ページ境界・めくりを比べる構造ネームであり、ページ下の
◆レイアウト(裁ち切り、斜め、figure等)とは別レイヤーである。候補セットは3回の`count:1`ではなく、原則1回の
`count:3`で作る。組み込みLLMが失敗して決定的fallbackになった場合、同一group内の重複は1件へ畳まれるため、
同じfallbackを別groupで3件作ってA/B/Cに見せない。差のある3案が必要なら、接続を直してLocal LLMで再生成するか、
外部サブエージェントが可読性・映画的・テンポ重視の独立planを作り、固定revision付きimport APIで同じgroupへ載せる。
外部演出済み候補の採用では組み込みLLM監督を再度呼ばず、そのplanを`planningMode:"provided"`としてV2 validation/full preflightへ通す。
ネームスタジオもページ/コマ境界・beat割当・スケール・めくりが同じ候補は1件へ畳み、比較タブとして水増ししない。

## 1. 生成より先にネームを確定する

最初のrunは`generateImages:false`（prepare-only）で作る。ネーム（N1）は、利用可能なら画像評価とは分離した上位モデルまたは専任サブエージェントに担当させ、同じ脚本から複数候補を作って比較する。上位モデルは情報開示順、ページ送り、反応、見せ場の判断には有効だが、コマ数上限、台詞の一度だけの割当、visible cast、文字収容を自動的に保証するものではない。最終的にはMangaPlan validationと全panel preflightを通す。

prepare後、画像生成を承認する前に全ページについて次を説明できる状態にする。

- そのページに誰が実際に見えているか
- 一つのコマがどの瞬間と主行動を示すか
- 前ページから何を受け、次ページへ何を渡すか
- 原文の各台詞が脚本順に一度だけ割り当てられているか
- 必須の場所、人物、動作、小道具、状態変化にsource elementまたはdialogue上の根拠があるか

## 2. ネーム密度を先に制約する

Script画面とrun作成APIでは、次の密度指定を画像生成前に固定する。

| 指定 | 意味 |
| --- | --- |
| `targetPageCount` | 希望ページ数。`0`は脚本量から自動決定。LLMネーム候補にも渡るが、厳密なページ数保証ではない |
| `panelsPerPage` | 1ページのコマ数上限（1〜6）。`targetPageCount`未指定時は最終ページを除く既定密度 |
| `maxDialoguesPerPanel` | 1コマへ割り当てる台詞要素数の上限（1〜8、既定3）。実際の吹き出し数はadapt分割等で一致しない場合がある |
| `maxPanelCount` | plan全体のhard ceiling（1〜800）。`0`は上限なし。超過planは生成キューへ入れない |

`maxDialoguesPerPanel`は「常に台詞を詰める」指定でも、吹き出し数だけで品質を決める規則でもない。近接した応答を同じコマへまとめてよいのは、同じscene、同じ瞬間、同じ主行動を共有し、話者順と反応が一枚で理解できる場合だけである。時刻、場所、主行動、人物の出入り、状態変化のいずれかが変わる場合はコマを分ける。複数台詞を割り当てたコマの最終可否は、`POST /api/text-layout`、実フォント、最小可読サイズ、コマ内専有率のpreflightで判断する。

heuristic planningでも`targetPageCount`は有効で、生成済みの連続コマを1ページ1コマ〜`panelsPerPage`の範囲へ均等配分する。空ページは作らず、コマ密度上限を破って目標へ押し込まないため、指定値はbest-effortである。目標よりページ数が多い場合は、`maxDialoguesPerPanel`などのhardなコマ分割条件を先に見直す。

長編では、まず`maxPanelCount`を現実的な生成予算に設定し、候補ネームのページ数・コマ数を比較する。上限を外してから数百コマを投入し、後で全体を圧縮する運用は避ける。

会話進行帯の「つなぎ」ショット(continuing/static)でも、promptBaseを「Exterior static shot continuing」のような薄い定型文にしてはいけない。cast空のコマは特に、モデルが画面外話者や無関係な人物・静物を自由連想で描くため、その瞬間に見えるsetting・props・光・カメラ位置など具体的なvisual factを必ず書き、画面外話者は`mustNotShow`の`entity-absent`で明示する(ALICE_REBOOT_E02で系統的なretry多発の実績原因)。

既定の`stylePrompt`はジャンルを決めないモノクロ日本漫画である。SF、恋愛、時代劇などのジャンルや、破損、廃墟、未来的といった状態は脚本または明示した`stylePrompt`に根拠がある場合だけ加える。prompt compilerは作品固有辞書で日本語を疑似翻訳しない。natural方言では原文のvisual factを保持し、tags方言では上位plannerが英語のvisual factを構造化して渡す。未翻訳のfallbackを削除・脚色してはいけない。

## 3. visible castと画面外発話

visible castは、通常の画面内発話、または対応するaction/source elementがその瞬間に画面内へ置く人物を正とする。画面外deliveryのspeakerだけを根拠に人物を自動追加しない。

V.O.、通信、無線、機械音声、アナウンス、ナレーション、記録音声などのdeliveryは、吹き出し表現と「話者をcastへ自動追加しない」判断に使う。ただしdeliveryは人物の不在を意味しない。同じsource elementのactionが話者の姿を明示している場合、その人物は通常visible castへ残す。close-upやinsertで意図的にフレーム外へ置く場合だけ、castから外したうえで`mustNotShow`へ`{ kind:"entity-absent", entityId }`を明示する。この指定がないaction-grounded人物のcast欠落はvalidation errorになり、明示した人物名はmaterialize時にprompt/must-show/compositionから除去される。したがって、吹き出しstyleや話者名の単語一致だけを根拠に、actionで根拠づけられた人物を無言でcastから削除してはいけない。

自由文actionの人物抽出は、同じsceneのsourceにある肯定的な主語と物理行動を保守的に認識し、未来、否定、伝聞、写真、画面、通信、宛先など曖昧な言及は人物追加の根拠にしない。別sceneのsource elementをpanelへ混ぜるplanはvalidation errorになる。silent actorが曖昧な文型になる場合はFountain actionへ`[[cast: Name]]`または`[[character: Name]]`を付ける。このtagはsource上の明示根拠であり、画像promptだけへ人物名を足す代用品ではない。

群衆、人影、反射、モニター内の顔、背景人物を補う場合も同じで、source上の明示が必要である。採用時は人物名だけでなく人数もplanと画像で照合する。

## 4. successor runと採用画像の継承

承認済みrunのplanを根本修正するときは、同じ固定revisionを引き継ぐsuccessor runを作る。`successorPlan`は部分差分ではなく、修正後の完全なMangaPlanV2を渡す。

次はbodyの概略であり、`successorPlan`内部の必須フィールドは省略している。

```http
POST /api/projects/{projectId}/script-manga-runs
Content-Type: application/json

{
  "scriptId": "script-same-as-predecessor",
  "planningMode": "provided",
  "predecessorRunId": "run-v12",
  "successorPlan": { "version": 2, "...": "complete MangaPlanV2" },
  "generateImages": false,
  "maxPanelCount": 160
}
```

`scriptId`はpredecessorと同一でなければならない。template、provider、LoRA、画像サイズ、sampler等を省略した場合はpredecessorのrun設定を引き継ぐ。作成後は通常どおりplanを監査して`approve`、`start`する。

継承対象はpredecessorで人が選択済みで、固定revision、source/dialogue、visible cast、action/props/setting、compiled prompt、reference snapshot、layout/画像寸法、生成設定から成る再利用fingerprintが完全一致するコマだけである。一致したselected assetは新taskへ割り当てられ、新taskを`completed`として生成をskipする。変更コマと未採用候補は継承しない。旧taskに署名が無い場合は、selected asset自身の凍結request、intent、native workflow、template version/hashがすべて揃うときだけ遅延署名し、mutableな現行templateから推測しない。凍結情報が欠ける旧taskはfail-closedで再生成する。assetを複製したりpredecessorの採用状態を変更したりせず、run/taskのlineageを記録する。

`continuityFromPanelIds`を持つコマの継承は、依存先がpredecessorで**採用済み**の場合のみ「依存先も同じペアで継承成立していること」を要求する。依存先が未採用(レビュー途中のcancel等)のままだった場合、その依存コマの承認は確定した依存先画像を前提にしていないため、依存コマ自身のfingerprint一致(継続コマの意味論を含む)だけで継承し、依存先はsuccessorで再生成される。依存先が採用済みなのに継承できない(画像破損・凍結情報欠落・material不一致)場合は、従来どおり依存コマも連鎖的に再生成される。

reuse fingerprint v4は、通常のtxt2img selected assetに加え、局所repair後に人が選択したimg2img assetも追跡する。検証署名には採用画像bytesのSHA-256と実寸、provider/template、凍結request/intent/native-workflowを含める。repairではさらに親asset/round lineage、mask content SHA-256、denoiseとmask方式を署名し、prompt、negative、sampling、LoRA、reference、pose/controlなど非repair条件が親と一致する場合だけ元コマのroot fingerprintへ対応付ける。画像pathが同じでもbytesが変わった場合、lineageが壊れた場合、凍結内容を読めない場合、可変character bindingしかない場合はfail-closedで再生成する。

`start`または`resume`時に継承判定を行うため、successor作成後にplanを確認せず自動生成へ進めない。完全一致しないコマを節約目的で強制継承してはいけない。

## 5. poseとinpaintの境界

漫画runのpose selectorは`off / full / upper / face`を選べる。選択値から決定的な骨格画像を作るが、実際に効くのはworkflow templateに`ControlNetApplyAdvanced`があり、互換ControlNetが接続されている場合だけである。標準Anima templateはControlNet非対応なのでposeを指定しても利用できない。対応templateへ切り替えるか、Anima向け互換経路を別途実装する。

`awaiting_review`の漫画候補は、候補カードの「マスク編集」から既存asset detailを開き、白い修復領域を描いて「適用」後に「このマスクでコマ修復」を実行できる。APIを直接使う場合は次の形で送る。

```http
POST /api/script-manga-tasks/{taskId}/repair
Content-Type: application/json

{
  "assetId": "asset_parent_candidate",
  "denoise": 0.45,
  "inpaint": {
    "maskDataUrl": "data:image/png;base64,...",
    "maskedContent": "original",
    "inpaintArea": "only_masked",
    "onlyMaskedPadding": 32,
    "featherRadius": 0
  }
}
```

maskは親候補と同じ寸法のPNG、白が修復、黒が保持、8MB以下とする。`denoise`は省略時0.45、指定時は0より大きく1未満、paddingは0〜512、featherは0〜30である。prompt、negative prompt、workflow、seed、steps、CFG、sampler、scheduler、LoRA、人物参照、poseはクライアントから上書きできず、親候補のroundから固定される。template revision、seed、参照、poseを安全に再現できない場合やtemplateがinpaint非対応の場合は明示的に失敗し、txt2imgへfallbackしない。

成功assetは旧候補を消さず同じtaskへ追加される。新旧を並べて比較し、どちらでも`select`できる。修復roundが失敗、0 asset、欠落になっても旧候補があれば`awaiting_review`へ戻る。`scores.repairs`にはround ID、親asset ID、denoise、mask方式、padding、featherだけを残し、mask data URLやpromptは保存しない。VLM違反領域を自動mask化するrepair plannerは未実装であり、現行`retry`は別機能としてコマ全体を再生成する。

## 6. 候補比較と書き出し

良好なページと採用候補を保持し、変更したコマだけを比較する。組み込みVLMでも視覚対応の外部エージェントでも、比較順は脚本逸脱、余計な人物、因果関係、連続性、偽文字・崩壊、画面美の順とし、総合的に改善した候補だけを`select`する。同じ生成失敗が続く場合はseed変更を止め、plan、cast、prompt、reference set、templateの共通原因へ戻る。

completed runの書き出しは`POST /api/script-manga-runs/:runId/export`を使う。JPGは`format:"jpeg"`、PowerPointは`format:"pptx"`を指定する。

源暎アンチックを使う場合は、フォントファイルをOSのユーザーフォントまたはrepository外のGURUGURU fontsディレクトリへ導入する。script-mangaが新規自動配置する台詞・captionには導入済み源暎アンチックの実font IDを明示し、一般ページの`fontId:"default"`は従来の日本語font優先順を維持する。JPGの描画とPPTXの編集可能テキストには同じfamily名を使う。フォント自体はPPTXへ埋め込まないため、開く環境にも導入し、`GET /api/fonts`とJPG/PPTXの目視で置換・改行ずれがないことを確認する。

## 7. 安全な調査と実行

- runtime DBを直接編集・dump・要約しない。エージェントはrun、plan、task、page、candidateを`agent:cli`経由のGURUGURU APIで確認し、GUIは人間ゲートだけにする。
- 本番ComfyUIの`/history`、`/view`、input/outputディレクトリを調査に使わない。疎通は`/queue`、`/system_stats`、`/object_info`に限る。
- テストでは`GURUGURU_TEST_DB=1`を必須にし、必要ならrepository外の`GURUGURU_TEST_DATA_DIR`を指定する。
- エージェント検証用GURUGURUは5177以外のportを使う。本番データと同じdata directoryで複数instanceを起動しない。
- 制作の短い反復記録はrepository外へ置き、対象ページ、原因、変更、比較結果、次の試行だけを残す。
