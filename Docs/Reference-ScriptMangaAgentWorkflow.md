# Script Manga エージェント運用リファレンス

FountainからMangaPlanV2を作り、画像生成・候補採用・書き出しまでを自動化する利用者／コーディングエージェント向けの現行手順である。個別作品の全文prompt、候補画像、制作ログはrepositoryへ保存しない。

## 0. ネーム選択の人間ゲート(attended運用、ネームスタジオV5)

エージェントが候補を作り、**人間が localhost のネームスタジオで読んで選ぶ**運用。無人運転
(以降の節どおりエージェント自身が採用・承認する)も引き続き可で、依頼者が見ている場合はこちらを使う。

```
0. 前提チェック(URL案内より前に確認):
     - workflow template が作成済み(スタジオの採用ボタンは templateId 未設定だと disabled)
     - キャラの reference set が承認済み(採用POSTは requireReferenceSets:true 固定。
       未整備だと materialize が blocked で 422 になり人間側の採用が成立しない)
1. POST /api/projects/:id/script-manga-plan-candidates {scriptId, count:3, ...}   ← 候補提示
2. 人間へ script 画面のURLを案内(以後エージェントはネームに触らない。ページは5秒毎に
   ライブ更新され、追加候補・レイアウトフリップ・採用が自動で映る)
3. GET 同エンドポイントを15〜30秒毎にポーリング:
     - いずれかの candidate.status === "adopted" → adoptedRunId を「即座に」記録して次へ
       (採用済み候補も人間が破棄でき、破棄されると一覧から消えて runId の再取得手段が無い)
     - status === "adopting" は採用処理中(監督LLM実行中)。この間 set-layout は 409
     - 人間がUIで追加生成した候補が増えても構わず待つ
     - 空リスト化・既知候補idの消失(=人間が脚本を再importしてrevisionが進んだ)なら
       候補を作り直して再提示。※一覧GETは409を返さない。409(stale candidate)は
       採用APIを自分で叩くunattended経路でのみ起きる
4. GET /api/script-manga-runs/:runId をポーリング:
     - approvalStatus === "approved" になるまで待つ(この間、人間が演出ネームを確認し、
       POST /api/script-manga-plans/:planId/edits 相当のスタジオ編集をしていることがある)
5. POST /api/script-manga-runs/:runId/start → 以降は既存の生成・レビューフロー
```

採用runの生成設定(template等)は、採用ボタンを押すブラウザ側の script 画面設定が使われる
(エージェントは手順2の案内時に必要な設定値を人間へ伝える)。候補のページ別レイアウトは
`POST /api/script-manga-plan-candidates/:id/set-layout` (`{pageIndex, layoutTemplateId, expectedVersion}`)
で人間・エージェントのどちらからでも変更でき、`expectedVersion`(候補の `editVersion`)の楽観ロックで
競合を検出する。基礎プラン(`plan`)は不変で、選択は `layoutOverrides` に載る。

V5の語彙変更: コマの重みは `visualScale`(`small/medium/large/splash`)。provided plan では旧
`importance`(`splash/hero/normal`)も引き続き受理され `visualScale` へ写像されるが、新規は
`visualScale` を使う。ネーム監督はレイアウトを選ばない(`layoutTemplateId` は監督schemaから削除済み。
provided/候補のレイアウトがそのまま使われる)。

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
| `maxDialoguesPerPanel` | 1コマへ割り当てる台詞要素数の上限（1〜8、既定4）。実際の吹き出し数はadapt分割等で一致しない場合がある |
| `maxPanelCount` | plan全体のhard ceiling（1〜800）。`0`は上限なし。超過planは生成キューへ入れない |

`maxDialoguesPerPanel`は「常に台詞を詰める」指定でも、吹き出し数だけで品質を決める規則でもない。近接した応答を同じコマへまとめてよいのは、同じscene、同じ瞬間、同じ主行動を共有し、話者順と反応が一枚で理解できる場合だけである。時刻、場所、主行動、人物の出入り、状態変化のいずれかが変わる場合はコマを分ける。複数台詞を割り当てたコマの最終可否は、`POST /api/text-layout`、実フォント、最小可読サイズ、コマ内専有率のpreflightで判断する。

heuristic planningでも`targetPageCount`は有効で、生成済みの連続コマを1ページ1コマ〜`panelsPerPage`の範囲へ均等配分する。空ページは作らず、コマ密度上限を破って目標へ押し込まないため、指定値はbest-effortである。目標よりページ数が多い場合は、`maxDialoguesPerPanel`などのhardなコマ分割条件を先に見直す。

長編では、まず`maxPanelCount`を現実的な生成予算に設定し、候補ネームのページ数・コマ数を比較する。上限を外してから数百コマを投入し、後で全体を圧縮する運用は避ける。

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

良好なページと採用候補を保持し、変更したコマだけを比較する。比較順は脚本逸脱、余計な人物、因果関係、連続性、偽文字・崩壊、画面美の順とし、総合的に改善した候補だけを`select`する。同じ生成失敗が続く場合はseed変更を止め、plan、cast、prompt、reference set、templateの共通原因へ戻る。

completed runの書き出しは`POST /api/script-manga-runs/:runId/export`を使う。JPGは`format:"jpeg"`、PowerPointは`format:"pptx"`を指定する。

源暎アンチックを使う場合は、フォントファイルをOSのユーザーフォントまたはrepository外のGURUGURU fontsディレクトリへ導入する。script-mangaが新規自動配置する台詞・captionには導入済み源暎アンチックの実font IDを明示し、一般ページの`fontId:"default"`は従来の日本語font優先順を維持する。JPGの描画とPPTXの編集可能テキストには同じfamily名を使う。フォント自体はPPTXへ埋め込まないため、開く環境にも導入し、`GET /api/fonts`とJPG/PPTXの目視で置換・改行ずれがないことを確認する。

## 7. 安全な調査と実行

- runtime DBを直接編集・dump・要約しない。run、plan、task、page、candidateはGURUGURU APIまたはUIから確認する。
- 本番ComfyUIの`/history`、`/view`、input/outputディレクトリを調査に使わない。疎通は`/queue`、`/system_stats`、`/object_info`に限る。
- テストでは`GURUGURU_TEST_DB=1`を必須にし、必要ならrepository外の`GURUGURU_TEST_DATA_DIR`を指定する。
- エージェント検証用GURUGURUは5177以外のportを使う。本番データと同じdata directoryで複数instanceを起動しない。
- 制作の短い反復記録はrepository外へ置き、対象ページ、原因、変更、比較結果、次の試行だけを残す。
