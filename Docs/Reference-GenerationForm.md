# 生成フォーム draft リファレンス

生成フォーム(プロンプト・生成パラメータ)の編集内容(draft)の保持・復元・リセットに関する内部実装メモ。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## Round ごとの編集内容の記憶(per-round draft)

- `state.generationDraftsByRound`(roundId → GenerationDraft)に、Round ごとの「最後に編集していたフォーム内容」を記憶する。Round 切替・ブランチングの直前に `rememberActiveRoundDraft()` が現在のフォームを保存し、切替先で `restoreGenerationDraftForRound(roundId)` が記憶済み draft を復元する(ブランチング後に親ノードへ戻っても編集値が残る)。
- 記憶が無い Round では従来どおり denoise のみ引き継ぎ(`preserveGenerationDenoise`)、他の値は Round の `request` 値へフォールバックする(`currentXxxValue` 系)。
- 生成送信時(`generationController.ts`)も、送信した request から作った draft を新 Round の per-round draft として登録する。

## 「ノード元値」リセット

- フォームの「ノード元値」ボタン(旧称「JSON初期値」)は、編集内容を**表示中ノード(activeRound)の開始時点の値(`round.request`)へ戻す**(`resetGenerationParamsToNodeValues`)。request を持たないノード(初回など)は従来どおり Workflow JSON の初期値へフォールバックする(`resetGenerationParamsToTemplateDefaults`)。

## localStorage への永続化

- draft(`generationDraft` / `generationDraftsByRound` / `inpaintDrafts` / `poseDrafts`)はプロジェクト単位で localStorage(`guruguru:draft:<projectId>`)に永続化する(`draftStore.ts`)。
- 書き込みは **debounce(`PERSIST_DRAFT_DEBOUNCE_MS` = 400ms)** で行う。InpaintDraft のマスク dataURL は数MBになりうるため、ストローク中の毎フレーム書き込みは UI を目に見えて遅くする。アイドル後に 1 回だけ書き、`unload` 時とプロジェクト切替時(state 差し替え前)に `flushProjectDraftPersist()` で確定させる。
