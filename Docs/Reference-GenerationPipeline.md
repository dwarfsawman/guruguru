# 生成パイプライン リファレンス

バッチ生成のジョブ分解・進捗監視・停止に関する内部実装メモ。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## 逐次生成・停止

- 通常生成の `batchSize` は ComfyUI 内部の大きな1バッチではなく、GURUGURU 側で `batch_size=1` の `generation_jobs` に分解してキュー投入する。
- 各ジョブは同じ ComfyUI `client_id` を使い、サーバー側 WebSocket で `executed` / `execution_success` / `execution_interrupted` / `execution_error` を監視する。WebSocket通知を取り逃がした場合も、UIの自動 `collect` polling で回収する。
- UIの自動 `collect` polling は3秒間隔。サーバー側 WebSocket 監視が先に画像を取り込んだ場合も、`collect` 応答の round 集計数を見てUIを再読込する。
- 分割ジョブの seed は round に保存した先頭 seed を基準に、`batchIndex` ごとに `seed + batchIndex` を使う。asset の seed は各ジョブの実 seed。
- 停止ボタンは未実行・待機中 prompt を ComfyUI queue から削除し、実行中 prompt がこの round のものと判断できる場合は ComfyUI `/interrupt` を呼ぶ。保存済み asset はそのまま残り、停止後も選択や画像からのブランチングに使える。
- 複数アプリや別ユーザーが同じ ComfyUI を共有する運用では、`/interrupt` が現在実行中の ComfyUI ワークフローへ作用する点に注意する。

## MangaPlanV2 runとの接続

- Fountain一括漫画では、`script_revision_id`、LLM provenance、`dialogueSnapshots`、ページごとの`layoutSnapshot`を含む`script_manga_plans`を先に保存する。run所有ページとコマ単位の`script_manga_tasks`を準備してから、各taskをbatch 1の`generation_rounds`へ接続する。実行時に最新revision、最新台詞、mutableなlayout templateを再解決しない。
- runの主要phaseは`planning → awaiting_approval → preparing_references → rendering → auditing(VLM時) → reviewing → completed`。`generateImages:false`は`awaiting_approval`で止まり、通常作成はapprove/startまで自動で進む。
- prepare/adoption時は必須Reference Set不足だけをpreflightで遅延し、採用planの実際のvisible castが確定してからsetを作成できる。run承認時に承認済みsetのsnapshotを固定し、そのsnapshotで全taskをstrictに再materializeする。不足やpreflight errorがあれば承認transactionをrollbackし、runは`prepared` / `pending`のまま残る。
- `resume`は`script_manga_run_pages`と既存taskを再利用し、running roundの監視を張り直して承認済みpending taskだけを投入する。ページ/taskのunique制約により再開時の重複を防ぐ。
- round完了後は候補assetとメタデータscoreをtaskへ保存する。`auditMode:manual`はそのまま外部エージェント/人間review、`auditMode:vlm`は内蔵VLM補助監査後にreviewへ進み、いずれも`select`による明示採用後だけコマへ割り当てる。
- run所有ページのlayout変更・直接削除と、script manga task履歴を含むround treeの削除は409で拒否する。未承認planのPATCHだけがownershipを保った再materializeを行える。
- runの`cancel`はactive roundへ既存のinterrupt処理をbest effortで適用する。taskの`retry`は同じtask IDを再利用して新しいroundへ接続する。
- 全task選択後のcompleted runは`POST /api/script-manga-runs/:runId/export`で所有ページだけを`png/jpeg/pptx/ora`へ書き出し、`export_manifest_json`へpage順と成果物情報を保存する。
- MangaPlanV2、API、preflight、参照downgradeの詳細は[`Feature-MangaPlanV2.md`](Feature-MangaPlanV2.md)を参照する。

## VLM監査・GPU入替

- run作成時の`auditMode`は`manual | vlm`。raw APIで省略するとmanual、Script画面の初期値はvlmである。`manual`は内蔵VLMを使わず、許可された外部エージェントまたは人間が明示レビューする後方互換名である。候補policyは常にreviewで、自動採用はしない。
- 既定VLMはLM Studioで管理するHauhauCS Gemma-4-E2B Q6_K_P + matching mmproj。model fileはrepository/dataRootへ保存せず、LM Studio model storageへ事前importする。GURUGURUはdownloadしない。
- `getVlmAuditStatus()`は`/api/v1/models`によるreadiness probeだけを行い、load/unloadや候補画像の読取をしない。設定は`GET/PUT /api/settings/vlm-audit`、probeは`GET /api/vlm-audit/status`。
- 同じrunのgeneration taskがすべてidleになった後、Comfy providerではglobal `/queue`のrunning/pendingが空かを確認する。busyなら`deferred`として`/free`を呼ばない。idleなら`/free { unload_models:true, free_memory:true }`でComfy modelを解放する。
- LM Studio native lifecycleは`/api/v1/models`でvision capabilityを確認し、必要時だけ`/api/v1/models/load`する。load時は既定context 4096、flash attention ON、KV cache GPU offload OFF。
- `visualAuditQueue`はprocess全体でrunを直列化する。run内もtaskとcandidateを`await`で順に処理し、Comfy modelとVLMを同時常駐させない。
- 監査入力はcandidate assetのmedium thumbnail 1枚と、PanelSpecのcharacter binding identity参照（既定3件、設定0〜6件）。dataRootのlexical/realpath境界を通った画像だけを一時data URL化する。data URL、path、生レスポンスはtask結果へ保存しない。
- native chatは`/api/v1/chat`へ`reasoning:"off"`、`store:false`で送る。要求schemaをpromptへ含め、返答をscore 0〜1、4つの`pass|fail` check、短いviolations配列としてexact validationする。
- task単位の通信・画像・JSON失敗は`unavailable`として人間reviewへ戻す。VLMの不合格も候補を削除しない。queue busyは`deferred`のまま安全な再試行を待つ。
- 全candidate処理後はfinallyで`/api/v1/models/unload`し、監査instanceを解放する。既定の`manageModelLifecycle`、`releaseComfyBeforeAudit`、`unloadAfterAudit`はすべてtrue。
