# Feature: MangaPlanV2 漫画制作制御層

> 状態: 進行中。2026-07-12 時点で、immutableなrevision/plan、実行ライフサイクル、P2最小UI、LM Studio VLM監査、候補の人間採用、run直結exportまでを実装済み。違反領域だけの局所inpaint修復は未実装。

## 目的

Fountainから画像プロンプトへ直接つなぐのではなく、脚本上の判断を編集・検証・再実行できるJSONとして保持する。1回のrunは作成時点の`script_revision_id`と`plan_id`へ固定し、後から脚本を再取り込みしても生成根拠を変えない。

現在の制御層は次を担当する。

```text
Fountain revision
  → NarrativeGraph / WorldState / Beat
  → MangaPlanV2（revision / dialogue / layout / planner provenanceを固定）
  → PageSpec / PanelSpecを検証して保存
  → run所有ページ・吹き出し・taskを冪等に準備
  → approve / start / resume / cancel / retry
  → 画像候補とメタデータ評価を保存
  → manual review、またはVLM監査
  → manualは人が候補をselect、VLMは合格候補だけを人がselect
```

VLMは人物同一性・行動整合・偽文字・連続性を補助評価するが、候補を自動採用しない。監査不能や不合格も候補を失わせず人間reviewへ戻す一方、VLM modeでは合格reportのある候補だけを採用できる。不合格時は同じtaskを再生成する。局所repairは保存済み`PanelSpec`と違反reportを将来の修復器が読む前提で境界だけを用意している。

## JSON契約

正本は`src/shared/mangaPlanV2.ts`の`MangaPlanV2`である。主要構造は次のとおり。

```jsonc
{
  "version": 2,
  "id": "manga_plan_...",
  "title": "...",
  "scriptId": "script_...",
  "scriptRevisionId": "script_rev_...",
  "dialoguePolicy": "preserve",
  "plannerVersion": "manga-plan-v2.1",
  "promptCompilerVersion": "panel-prompt-v2.2",
  "plannerProvenance": {
    "kind": "llm-director",
    "model": "...",
    "batches": [{ "rawOutput": "...", "messages": [{ "role": "system", "content": "..." }] }]
  },
  "narrativeGraph": {
    "sourceElements": [
      { "id": "source:<revision>:scene-0:element-0", "sceneIndex": 0, "elementIndex": 0, "type": "action", "text": "..." }
    ],
    "entities": [
      { "id": "character_...", "kind": "character", "name": "...", "aliases": [], "attributes": {}, "variants": [] }
    ],
    "worldStates": [],
    "beats": [],
    "warnings": []
  },
  "sourceDialogueLineIds": ["line_..."],
  "dialogueSnapshots": [
    {
      "id": "line_...",
      "orderIndex": 0,
      "sceneIndex": 0,
      "characterId": "character_...",
      "speakerLabel": "Alice",
      "text": "...",
      "semanticKind": "dialogue"
    }
  ],
  "pages": [
    {
      "index": 0,
      "title": "...",
      "layoutTemplateId": "builtin:four-grid",
      "layoutSnapshot": {
        "version": 1,
        "page": { "aspectRatio": [182, 257], "height": 1.412088 },
        "readingDirection": "rtl",
        "panels": [{ "id": "panel-layout-1", "order": 1, "shape": { "type": "rect", "bounds": [0.04, 0.04, 0.96, 1.372088] } }]
      },
      "pageIntent": "...",
      "panels": [
        {
          "id": "panel-1",
          "sourceElementIds": ["source:..."],
          "beatIds": ["beat:..."],
          "preStateId": "world:...",
          "postStateDelta": { "notes": [] },
          "settingId": "setting:...",
          "cast": [
            {
              "characterId": "character_...",
              "variantId": "character_...:default",
              "bbox": { "x": 0.08, "y": 0.08, "width": 0.36, "height": 0.78 },
              "expression": "...",
              "action": "...",
              "speakingLineIds": ["line_..."]
            }
          ],
          "props": [],
          "shot": {
            "size": "medium",
            "angle": "eye-level",
            "focalSubjectId": "character_...",
            "compositionIntent": "..."
          },
          "dialogueLineIds": ["line_..."],
          "dialogueOrderIndexes": [0],
          "textSafeZones": [],
          "mustShow": [],
          "mustNotShow": [],
          "continuityFromPanelIds": [],
          "referenceManifest": [],
          "sceneIndex": 0,
          "sceneHeading": "INT. ROOM - DAY",
          "sourceText": "...",
          "promptBase": "...",
          "compiledPrompt": "..."
        }
      ]
    }
  ],
  "panelCount": 1,
  "dialogueCount": 1,
  "createdAt": "..."
}
```

`scriptRevisionId`、`dialogueSnapshots`、各ページの`layoutSnapshot`、planner/compiler version、`plannerProvenance`が再実行の固定根拠である。実行時はmutableな最新revision、最新台詞、layout templateを再解決しない。LLM監督を使ったplanでは、model、batchごとのmessages、raw outputもprovenanceへ保持する。承認前PATCHでもrevision、dialogue snapshot、planner provenanceは元planから戻し、layout IDを変えたページだけ新しいlayout snapshotを取得して再検証する。

`validateMangaPlanV2`は、version、revision、ページ連番、layout snapshotのgeometryとコマ数、ID一意性、source/beat/world state/entity参照、bboxとsafe zone、全台詞snapshotの一度だけの割当、`compiledPrompt`を決定的に検査する。`dialoguePolicy`は`preserve | adapt | fill | generate`を表現できるが、現行の一括経路が受け付けるのは既存台詞をそのまま固定する`preserve`だけであり、他3種は400で拒否する。

`compiledPrompt`は`PanelSpec`から決定的に作る。話者・speech act・表情・行動・画角・bbox由来の領域・must/must-not・文字用余白を含め、台詞本文そのものは画像モデルへ渡さない。provided planでもscene-levelの`promptBase`だけに縮退させず、コマ固有のcastとmust-showを再注入する。既にbase promptへ画角があれば重複するshot/angleは追加しない。

## 永続化

| テーブル | 役割 |
| --- | --- |
| `script_manga_plans` | revisionに固定した`plan_json`、`validation_json`、planner/compiler version、承認状態を保存 |
| `script_manga_runs` | `script_revision_id`と`plan_id`、status/phase/approval、件数、設定、評価集計、budget、直近のrun export manifestを保存 |
| `script_manga_run_pages` | runが所有する`page_id`を`page_index`とlayoutへ対応付ける |
| `script_manga_tasks` | コマごとの`panel_spec_json`、ReferenceManifest、round、候補asset、選択asset、score、attempt、将来のrepair/dependency関係を保存 |

`evaluation_json`はtask件数、completed/failed/auditing/awaitingReview、`visualAuditRequired`を記録するrun集計である。候補ごとのVLM結果はtaskの`scores_json.vlmAudit`へ、`state`、model、evaluatedAt、score、passed、4 checks、violationsとして保存する。画像data URL、ファイルパス、プロンプト、生レスポンスは保存しない。`export_manifest_json`は直近のrun exportを保存する。`repair_parent_task_id`と`dependency_task_ids_json`は将来用で、現行経路は実処理に使わない。

## state machine

runは`status`（外向け状態）、`phase`（工程）、`approval_status`を分けて持つ。

```text
preparing / planning / pending
  → prepared / awaiting_approval / pending
  → approved / preparing_references / approved
  → running / rendering / approved
  → manual: awaiting_review / reviewing / approved
  → vlm: auditing / auditing / approved
       → awaiting_review / reviewing / approved
  → completed または completed_with_errors / completed / approved

任意の非終端状態 → canceled / canceled
作成・materialize失敗 → failed
completed → exporting / exporting → completed
```

- `generateImages: false`は`prepared`で止まり、plan、run所有ページ、吹き出し、pending taskをすべて保存する。
- `generateImages`を省略または`true`にすると、作成直後にapproveとstartまで自動で進む。`candidateSelectionPolicy`は`review`だけを受け付け、manual/VLMのどちらも生成後は人間の候補選択で止まる。
- `resume`は新しい状態を作らず、既存ページ/taskを再materializeし、running roundの監視を張り直し、承認済みのpending taskだけを投入する。
- `retry`は同じtaskをpendingへ戻して新しいroundを作る。既定budgetは1コマ3attemptである。

## API

| method / path | 現行動作 |
| --- | --- |
| `POST /api/projects/:projectId/script-manga-runs` | 最新revisionをその場で固定し、MangaPlanV2、run、所有ページ、taskを作る。`generateImages:false`でprepareのみ。`auditMode`は`manual | vlm`、候補policyは`review`のみ |
| `GET /api/script-manga-runs/:runId` | round状態をtask候補へ同期し、run集計を更新する。繰り返し呼び出し可能 |
| `GET /api/script-manga-plans/:planId` | 保存済みplanとvalidationを取得 |
| `PATCH /api/script-manga-plans/:planId` | 未承認plan全体を差し替えて再検証・再materialize。承認済み/running/review中は409 |
| `POST /api/script-manga-runs/:runId/approve` | validation済みplanを承認 |
| `POST /api/script-manga-runs/:runId/start` | 承認済みpending taskを生成へ投入 |
| `POST /api/script-manga-runs/:runId/resume` | 所有ページ/taskを再利用し、監視とpending投入を復旧 |
| `POST /api/script-manga-runs/:runId/cancel` | active roundをbest effortで停止し、非終端taskとrunをcancel |
| `POST /api/script-manga-runs/:runId/export` | completed runの所有ページだけを`png | jpeg | pptx | ora`で書き出し、manifestを保存 |
| `POST /api/script-manga-tasks/:taskId/retry` | budget内で同一taskを再投入 |
| `POST /api/script-manga-tasks/:taskId/audit` | VLM runの生成済み未選択候補を監査キューへ戻す。deferred/unavailable後の明示再試行にも使う |
| `POST /api/script-manga-tasks/:taskId/select` | `{ "assetId": "..." }`。保存済み候補だけを採用してコマへ割当 |
| `GET /api/settings/vlm-audit` | VLM監査設定を取得 |
| `PUT /api/settings/vlm-audit` | VLM監査設定を正規化して保存 |
| `GET /api/vlm-audit/status` | LM Studio/モデル準備状態を読取確認。モデルのload/unloadや画像読取は行わない |

planのPATCHは完全な`MangaPlanV2`を要求する。サーバはplan ID、script ID、revision ID、dialogue snapshots、planner provenanceを元の値へ固定してから検証する。raw APIで`auditMode`を省略した場合は`manual`、Script画面の初期選択は`vlm`である。

## run-page所有と冪等性

- `script_manga_run_pages`の主キーは`(run_id, page_index)`で、`page_id`もunique。resume時は同じindexのページを再利用する。
- `script_manga_tasks`は`(run_id, page_id, panel_id)`がunique。materializeは既存taskをupsertし、running/completed taskを作り直さない。
- 吹き出し割当は既存placementをskipし、未生成オブジェクトだけを配置する。同じrunをresumeしてもページ、task、吹き出しを重複させない。
- GET pollingは候補IDとscoreを同じtaskへ上書きし、採用済み/失敗/取消taskを再処理しない。
- planを未承認のうちにPATCHした場合だけ、当該runの所有ページを削除し、件数とtaskを新planから作り直す。
- run所有ページのlayout変更と直接削除は409で拒否する。承認前のplan PATCHを通さずgeometryやownershipを壊せない。
- `script_manga_task_id`を持つroundが削除対象treeに1件でも含まれる場合、round tree削除は409で拒否する。生成・監査・採用の履歴を通常のround trash操作で欠損させない。

## Character bindingとdowngrade

groundingは`characters`、`aliases_json`、`dialogue_lines.character_id`を使い、既知aliasを同じentity IDへ結ぶ。action/synopsis内の無言entityは既知alias、または`[[character: Name]]` / `[[prop: Object]]` / `[[vehicle: Name]]`で明示できる。曖昧な代名詞は推測せずwarningへ残す。

`ReferenceManifest`はコマ内の全castについて、runの`providerId`に一致する`character_bindings`から顔とLoRAを解決して保存する。顔パスはuser data dir配下だけを許可し、plan/taskには絶対パスではなく`characterBinding`参照を保存する。round作成時に専用attachmentへコピーされ、`GenerationIntent.identity.face`は`roundAttachment`になる。

現行`GenerationRequest`が渡せる顔参照は1件なので、focal subjectを優先し、次に発話行数の多い人物を主参照にする。他人物の参照はManifestへ残し、複数人物かつ顔参照1件ならpreflight warning `single-reference-downgrade`を付ける。人物LoRAとrun全体LoRAは名前で重複排除し、強い値を採用して最大4件まで渡す。regional conditioningや人物ごとの逐次inpaintは未実装である。

## preflightと文字最小値

画像生成前に各taskで次を検査する。

- layout panelの存在、ページ内かつ最小幅・高さ0.04以上
- cast/prop/text-safe-zoneのnormalized geometry
- source element、beat、pre-stateへの追跡可能性
- dialogue IDと固定order indexの対応
- ReferenceManifestが当該コマのcast/propだけを参照していること
- 台詞本文が`compiledPrompt`へ漏れていないこと
- 吹き出し安全領域とcast/prop geometryの重なり（warning）

errorがあるtaskは`blocked`となり、runのmaterializeは422で失敗する。warningは保存するが実行を止めない。

吹き出しは従来どおり0.0352 page-widthを基準にfitするが、MangaPlanV2経路はfit後に0.02未満へ縮んだ本文を不合格にする。読めない大きさで通過させず、台詞分割またはページ再計画を要求する。実配置した吹き出し領域は`textSafeZones`へ戻し、再コンパイルしたpromptで文字領域を空けるよう指示する。

LLM監督モードでは、元の脚本・台詞を原文のまま保存する一方、LLM構造化応答の`pageIntent`、`shot`、`subject`、`action`、`emotion`、`composition`、`prompt`はすべて英語に統一する。後段コンパイラは英語の演出メタデータ、文字領域制約、共通品質制約を使い、NarrativeGraphに残る原語の人物名・説明は生成promptへ再挿入しない。決定的プランナーモードは従来どおり構造化メタデータをコンパイルする。

## candidate review

round完了時は候補を自動採用しない。dimensionsの有無と生成要求に対するaspect ratio差（許容8%）を決定的に採点し、`candidate_asset_ids_json`と`scores_json`へ保存する。新規runは`candidateSelectionPolicy: "review"`だけを受け付け、manual/VLMのどちらも`select` APIにより人が選んだ後だけ`completed`になる。

- `auditMode: "manual"`: メタデータscoreを保存して直ちに`awaiting_review`へ進む。
- `auditMode: "vlm"`: taskを`auditing`へ進め、VLMが`visualIdentity`、`actionAlignment`、`fakeText`、`continuity`を`pass | fail`で評価する。scoreが閾値以上、全checkがpass、violationsが空のときだけVLM上の`passed`になる。
- `passed`は推薦情報であり採用権限ではない。不合格候補も削除せず、人が原寸画像・メタデータ・違反理由を見て採否を決める。
- VLM通信・モデルload・画像読取・JSON検証が失敗したtaskは`vlmAudit.state: "unavailable"`として`awaiting_review`へ戻す。監査不能を生成失敗や自動不採用にしないfail-openである。
- ComfyUI global queueが動作中の場合は`deferred`として`auditing`に留め、`GET run`または`POST task/audit`で安全になってから再試行する。

## LM Studio VLM監査とVRAM入替

既定構成はLM Studio native APIと、LM Studioへ事前importした`HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive`のQ6_K_P GGUF + 対応mmprojである。GGUF/mmprojはGURUGURU repositoryやruntime data dirへ置かず、LM Studioのmodel storageで管理する。GURUGURUはモデルをdownloadしない。

1. 同じrunの全generation taskがidleになるまで待つ。
2. Comfy providerの場合、global `/queue`のrunning/pendingがともに空であることを確認する。空でなければ監査をdeferし、`/free`を呼ばない。
3. `/free`へ`unload_models:true, free_memory:true`を送り、ComfyUIのmodelをVRAMから解放する。
4. LM Studio `/api/v1/models`でdownload済み・vision capableな`modelKey`を確認し、未loadなら`/api/v1/models/load`でon-demand loadする。
5. process全体の`visualAuditQueue`でrunを1本ずつ処理し、run内もtask→candidateを直列評価する。候補画像はassetのmedium thumbnail、続く画像はidentity用character bindingで、既定3件、設定可能0〜6件である。
6. `/api/v1/chat`へ`reasoning:"off"`、`store:false`、候補/参照のdata URL、PanelSpec制約、要求JSON schemaを送る。返答はexact key、score範囲、4 checks、短いviolations配列をサーバ側でも検証する。
7. 全候補の終了後、`/api/v1/models/unload`で監査instanceを解放する。

既定ではComfyUI modelとVLMを同時常駐させない。VLM監査中に新しいComfy generationを投入せず、監査終了後の次generationでComfy側が必要modelを再loadする。`transport: "openai-compatible"`も設定可能だが、Gemma 4の画像入力とreasoning無効化を明示する既定経路は`lmstudio-native`である。

VLM設定の既定値は次のとおり。`PUT /api/settings/vlm-audit`は数値を安全範囲へclampする。

| 設定 | 既定値 / 意味 |
| --- | --- |
| `baseUrl` | `http://127.0.0.1:1234/v1`。native呼出し時は末尾`/v1`を除く |
| `model`, `modelKey` | `gemma-4-e2b-uncensored-hauhaucs-aggressive`。load後はinstance IDを推論へ使う |
| `transport` | `lmstudio-native` |
| `temperature`, `timeoutSeconds` | `0`, `180` |
| `maxReferenceImages` | 既定3、設定範囲0〜6 |
| `passThreshold` | `0.65` |
| `contextLength` | `4096` |
| `manageModelLifecycle` | `true`。on-demand loadを有効化 |
| `releaseComfyBeforeAudit` | `true`。queue idle確認後のVRAM swapを有効化 |
| `unloadAfterAudit` | `true`。監査instanceをfinallyで解放 |

## P2最小UI

Script画面の「MangaPlan V2 / 一括生成」カードからworkflow template、planning mode、1ページのコマ数、dialogue policy、audit modeを選び、常に`generateImages:false`と人間review policyでprepareする。plan warning、revision、page/panel数、run status/phaseを表示し、承認、生成開始、再開、更新、キャンセルを操作できる。VLM statusは非ブロッキングに取得し、ready、on-demand load可能、unreachable、未設定、manual/OFFを区別する。

生成後はtaskごとにmedium thumbnail、原寸リンク、VLM score/check/violation/modelを並べ、採用ボタンから明示的にselectする。VLMのqueued/deferred/unavailableも区別して表示する。「このコマを再生成」は同じtaskをbudget内でretryし、completed runにはPNG/PPTX/ORAのdownload buttonを表示する。現行UIのdialogue policyは`preserve`だけが有効で、plan JSONを直接編集するvisual editorはまだない。

## run export

全taskの人間選択が終わった`completed` runは、`POST /api/script-manga-runs/:runId/export`でrun所有pageだけを書き出せる。bodyの`format`は`png | jpeg | pptx | ora`、画像系は既存exportと同じ`pixelWidth`/`quality`を受ける。page index順の`pageIds`、format、filename、content type、page count、createdAtを`export_manifest_json`へ保存し、生成したファイルを応答する。未選択taskがあるrunは409で拒否し、失敗時はrunを`completed`へ戻してerrorを残すため再試行できる。

## 未実装・次フェーズ

- 違反箇所だけをinpaintするrepair planner、`POST .../repair`、repair lineageの実運用
- VLM結果と顔embedding、OCR、人物検出、参照類似度を組み合わせる決定的な複合gate
- lettering後のページ可読性監査と、独立したrepair lineageを持つ`repairing` / `lettering` / `validating_pages`工程
- layout/PanelSpecをGUIで直接編集するplan editor、違反領域表示、局所repair UI
- `adapt` / `fill` / `generate` dialogue policyの実処理、一般的な照応解決、衣装・負傷・小物所有を更新する高度なworld-state tracker

既存の画像編集、inpaint、Chronicle、吹き出し再配置は利用できるが、まだVLM violationから自動的には呼ばれない。task retryはコマ全体を再生成するもので、違反領域だけの修復ではない。

## 検証

- `src/shared/mangaPlanV2.test.ts`: JSON契約と決定的validator
- `src/server/scriptMangaDirector.test.ts`: LLM構造化演出の保持
- `src/server/scriptManga.test.ts`: revision/dialogue/layout/provenance固定、prepare→approve→start→resume、所有保護、5/6コマ、参照binding、manual/VLM review、run export
- `src/server/panelVisualEvaluator.test.ts`: medium thumbnail、参照上限、LM Studio native reasoning off、strict JSON、dataRoot境界、fail-open用例外
- `src/server/vlmAudit.test.ts`: LM Studio on-demand load/reuse/unloadとstatus probe
- 完了前に`bun run typecheck`、`bun test`、`bun run check`を実行する。`bun run check`単独はtypecheck/testを含まない。

## 改訂履歴

- 2026-07-12: provided planのコマ固有visual facts欠落と重複画角を修正し、prompt compilerをv2.3へ更新。VLM不合格候補の採用を禁止。
- 2026-07-12: LLM監督の構造化演出メタデータを英語に統一し、元の脚本・台詞と画像生成promptを分離。prompt compilerをv2.2へ更新。
- 2026-07-12: immutable revision/dialogue/layout/provenance、所有ページ/round保護、P2 UI、LM Studio VLM監査、VRAM swap、run exportまで現行契約を更新。候補採用は常に人間reviewとした。
- 2026-07-12: 初版。MangaPlanV2、永続run state、manual candidate reviewと、未実装のaudit/repair/export境界を記録。
