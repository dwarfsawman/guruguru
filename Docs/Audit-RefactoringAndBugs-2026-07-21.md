# コードベース監査レポート: リファクタリング・バグ修正候補(2026-07-21)

- 監査方法: 読み取り専用の並列監査4系統(server / client / shared+横断 / 危険パターンGrepスイープ)。全所見はコード実読で裏取り済み。
- ベースライン: `bun run test` 1170件全パス(0 fail)。
- 前提: **UIの見た目・挙動・外部API仕様は不変**。内部構造のアグレッシブな刷新は可。

---

## 1. HIGHバグ(即修正推奨)

### サーバー
| # | 場所 | 内容 |
|---|---|---|
| S1 | `src/server/files.ts:34-39` | `streamFile` が `writeHead(200)` 後にストリームopen失敗(ENOENT)すると `sendJson` は headersSent で no-op、`res` が end/destroy されず**クライアントがタイムアウトまでハング**。全ファイル配信経路(assets/page-media/attachments/参照画像)に影響。`fileExport.ts:99-105` 同様に error 時 `res.destroy()` すべき。 |
| S2 | `src/server/rounds.ts:1262-1270` + `db.ts:769-787` | `generation_rounds.script_manga_task_id` に FK/NULL化トリガが無く、task 削除(plan更新・起動時リカバリ)でダングリング化。`deleteRoundTree` は無条件409のため**該当Round/ページが永久に削除不能**。task削除時NULL化トリガ or 実在チェックが必要。 |

### クライアント
| # | 場所 | 内容 |
|---|---|---|
| C1 | `poseEditorController.ts:312-317` | worker応答を受信時点の `activeAssetId` に適用。検出中(0.5〜3秒)にアセット切替すると**旧アセットのlandmarksが別アセットのdraftへ書かれlocalStorageに永続化**。requestId→assetId対応表で照合すべき。 |
| C2 | `webSamController.ts:215-218` | 同型レース(WebSAM)。`generationDraft.inpaint` フォールバック経由でモーダルを閉じても遅延適用される。 |
| C3 | `maskEditorController.ts:216-231` | マスクundoスタックがストローク毎にフル解像度canvas5枚を保持(2048²で1件≒84MB×20件/アセット)。`clearMaskUndo` はモーダルクローズで呼ばれず**GB級メモリリーク**。 |
| C4 | `panelShapeController.ts:795` ほか / `pageMosaicController.ts:364` | 8種のドラッグが `setPointerCapture` を呼ばない。ウィンドウ外でボタンを離すと「張り付きドラッグ」。paste/crop/pageObjects は capture 済みで不整合。 |
| C5 | `panelShapeController.ts:149-205` | PATCH非直列化。debounce保存と分割の即時保存が並走すると**分割がサーバ側で上書き消失**+後続PATCHが存在しないpanelId参照で失敗。古い応答での state 巻き戻りも。 |
| C6 | `pagePanelLightboxController.ts:707-713` | クロップのホイールズーム debounce commit(400ms)がどの離脱経路でも flush されない。**ズーム直後に閉じると保存されず巻き戻る**。 |
| C7 | `nameLayoutEditController.ts:177,212` | 楽観ロックが `baseVersion`(write-onlyのまま)でなく最新 `editVersion` を送るため**409にならずサイレント上書き**。`namePoseEditController.ts:247` は正しい実装で不整合。 |
| C8 | `scriptMangaController.ts:341-360` | 候補ポーリングに `nameLayoutEdit` ガードが無く、コマ割り修正セッション中も5秒毎に候補一覧が差し替わる(C7と相乗)。 |
| C9 | `scriptMangaController.ts:408-450` | 画面クローズ/脚本切替が `namePoseEdit`/`nameStudioDraft` をクリアしない。**Escape/Ctrl+Zの横取りが残留**+再オープン後 run ポーリングが永久skip。 |
| C10 | `generationController.ts:334,386-416` | auto-collect の `pollCollectRound` が `refreshProject(roundId)` 経由で `activeRoundId` を昇格。**生成中は3秒毎にユーザーのラウンド選択が強奪される**。 |

---

## 2. MEDバグ

### サーバー
- `src/server/comfy.ts:241-251` — `comfyFetchJson` が `JSON.parse` を `response.ok` 判定より先に実行。非JSONエラーボディで無関係な SyntaxError になり診断阻害。`llm.ts:242-297` は修正済み・comfy.ts のみ旧順序残存(2系統の監査で独立に検出)。
- `src/server/openRasterExport.ts:344-361` — `layers` が `[paperLayer]` 初期化のため `if (layers.length === 0)` が恒偽。**代表アセットfallback/Blank pageレイヤが到達不能**。意図は `=== 1` か。
- `src/server/index.ts:1189-1219` — `serveReleaseAsset` にバックプレッシャ制御なし(`write` 戻り値無視)。巨大onnxモデル配信でメモリ膨張。`pipeline()` へ。content-length欠損時に空文字ヘッダ送出も。
- `src/server/scriptManga.ts:3888-3894` — `reflowLetteringAroundFigure` が `plan.pages[pageIndex]` の位置アクセス。successorPlan で index≠配列位置だと**別ページの回避領域を適用**。`find` 版(:1585)に統一。
- `src/server/scriptManga.ts:1084-1095` — fill unit の `dialogue_lines` INSERT で `order_index` が全unit同値+`status='active'` のため次回 `loadActiveDialogues` が fill 由来行を通常台詞として拾う(データ汚染)。
- `src/server/storage.ts:16,101-124` — `thumbnailRepairTasks` が成功エントリを削除せず無制限成長(メモリリーク)+修復済み記憶でファイル再消失時に再修復されない(S1ハングに連鎖)。
- 文字列依存の制御フロー — `scriptManga.ts:3043`(`/deferred/i`)、`comfyProvider.ts:246-281`(`includes("404")`)、`scriptMangaCandidatePreflight.ts:204-276`(日本語文言への正規表現)。エラーに code プロパティを持たせる構造化が必要。
- `scriptManga.ts:788-795` — `parseConfig` の `as ScriptMangaRunConfig` キャスト。壊れた config_json で `templateId: undefined` のまま生成要求。

### shared
- `dialogueAutoLayout.ts:893-908` — `estimateTextObjectSize` の `maxWidth` 解釈が `textLayout.ts:80` の仕様(縦書き=列の最大高さ)と食い違い。折返しTextObjectの障害物bboxが誤る。未テスト関数。
- `layoutPresets.ts:611-630` — `externalScriptMangaLayouts` が shared 層のモジュールレベル可変シングルトン。サーバはプロセス全体共有・クライアントは常に空で、同じ shared 関数の結果が実行環境で変わる。

### クライアント(主要のみ、全38件は監査ログ参照)
- `pagePanelLightboxController.ts:467-491` — crop PATCH の応答順序ガードなし(古い応答で上書き)。
- `pagePanelLightboxController.ts:85-124 vs 168-216` — open/close の stateリセット約25フィールドが非対称な手書き2連リスト。`resetLightboxSessionState()` へ集約を。
- `pasteObjectController.ts:1028` — `loadingToastId` 未代入で「画像を読み込んでいます…」トーストが消えない(1行修正)。
- `pasteObjectController.ts:126-141` — GET復元と編集開始のレースで**サーバの既存添付が全量置換PUTで消える**。
- `pageMosaicController.ts:610` — モザイク多角形描画中の Esc が lightbox クローズまで素通り(「Escはlightboxより前に」の既知教訓と不整合)。
- `generationDraft.ts:52` + `views/generationPanel.ts:131-133` — txt2img後 `img2imgTemplateId:""` を `??` が素通りし**先頭テンプレートで img2img が走る**。
- `generationController.ts:537` — `exportSelected` がAPIを呼ばず成功トーストのみ(保存されたように見える)。
- `chronicleController.ts:291` ほか8箇所 — 非同期ガードが pageId のみで scriptId を見ず、脚本切替で旧結果が混入。`:113-122` は preview/選択のクリア漏れで旧脚本の placement を現ページへ apply 可能。
- `scriptMangaController.ts:232-256` — `candidatesBusy` が serial 不一致で true 固着(「候補を生成」恒久disabled)。
- `views/nameStudioView.ts:194-212` — 候補dedupが customLayouts/balloonHints を見ず、**人間が修正した候補が隠される**。
- pose/websam のモデル status 永続化残留(`poseDraft.ts:67-84` / `maskDraft.ts:61-81`)— 再オープン初回検出が必ず1回エラー。

### LOWバグ(件数のみ)
クライアント約50件(out-of-orderレース、undo残骸、ガード漏れ等)、サーバー5件、shared 9件。詳細は各監査ログ(セッション記録)参照。代表: seed `"0"` を未指定扱い(3箇所複製)、`pageLayout.ts:318 vs 358` の crop 下限不整合(0.01 vs 0.05)、`resolveAspectRatio` の 0 高さフォールバック誤り。

---

## 3. アグレッシブリファクタリング候補(UI挙動不変)

### 三本柱(クライアント)
1. **debounce保存機構の共通化** — `panelShapeController` / `pageMosaicController` / `pageObjectsController` に約60行×3の逐語コピー(`scheduleSave`/`startPersist`/`flush`/dirty)。`createDebouncedPersister({persist, isEditing})` を抽出すれば C5 の直列化修正も1箇所で済む。
2. **ドラッグセッション共通化** — 「pointerId照合→getScreenCTM変換→delta適用→up:履歴push+保存 / cancel:復元」の同一骨格が8ファイルに反復。`createDragSession({onMove, onCommit, onCancel})` へ畳めば setPointerCapture/button判定/cancel復元の不整合(C4ほか)が構造的に消え、`main.ts:663-822` の pointer 4イベント×13ハンドラ if チェーンも登録テーブル化できる。
3. **セッション状態のオブジェクト化** — `appState.ts` は約120フィールドのフラット構造(lightbox系だけで約40)。open時生成・close時破棄の「セッションオブジェクト」(タイマー/ドラッグ/dirty内包)へ再編すれば、リセット漏れ系バグ(C9、lightbox非対称ほか)を構造的に根絶。`loadHome`/`openProject`/`openBook`/`openPage`/`backToPages` に5重の手書きリセット部分集合も集約。

### 巨大ファイル分割
- **`src/server/scriptManga.ts`(4285行)→ 8分割案**(公開APIは不変): scriptMangaRows(行型/require系/view系) / scriptMangaLettering / scriptMangaMaterialize / scriptMangaReuse / scriptMangaSubmission / scriptMangaAudit / scriptMangaFigure / 残(runライフサイクルAPI+plan編集)。モジュール状態(activeTask* Set等)は submission/audit に自然に閉じる。
- **`views/pagePanelLightboxView.ts`(2350行)→ 7分割案**: shell / cropView / shapeEditView / mosaicView / objectsStageView / objectsSidebarView / dialogueDrawerView + 共有ヘルパ。HTML出力不変で機械的に分割可能。
- **`src/server/index.ts` routeApi(980行 if-chain)** → `[method, regex, handler]` ルートテーブル化。adopt の65行インラインは scriptMangaPlanCandidates.ts へ。
- `pageObjectsController.ts`(1890行)は三本柱①②適用後に4〜5分割。

### 危険な重複(修正漏れ事故の温床)
- **`scriptManga.ts:2500-2548 ⇔ 1841-1886`** — GenerationRequest組み立て+poseControl添付が submitTasks と reuse フィンガープリントで二重実装。片側だけ直すと**継承(reuse)が全滅/誤継承**する最重要重複。`buildPanelGenerationRequest()` 抽出必須。
- `dialogueAutoLayout.ts:353-419 ⇔ 422-473` — 候補スコアリング一式(avoidZones/上部優先/anchorHint/面積減点)がほぼ逐語コピー。スコア関数1つに抽出(約50行削減+片側修正漏れ防止)。
- `dialogueAutoLayoutApi.ts:341-389 ⇔ 487-542` — apply/reflow の SAVEPOINT トランザクションブロックが逐語重複。
- worker統合スキャフォールド(`poseEditorController` ⇔ `webSamController`)— C1/C2 の修正と同時に `modelWorkerClient` へ共通化するのが得。
- `requireScript`/`latestRevision` の三重実装(scriptManga / scriptMangaPlanCandidates / scriptMangaCandidatePreflight)。

### ユーティリティ多重実装の統合(shared へ集約)
- `escapeAttr` 4重(`htmlEscape.ts` に統一、+server の `escapeXml`)/ `clampNumber` 6重 / `isFiniteNumber` 5重 / 数値フォーマッタ5種(うち2つは逐語同一)/ shoelace面積3重 / `svgGizmo.ts` の角度正規化・中心固定拡縮は `pageLayout.ts` と逐語一致 / errorToJson系5実装 / MIME判定2重 / 一時ディレクトリヘルパ3組。
- EPS定数不揃い(1e-9 ×3 vs 1e-7 ×1)。

### 型・設定
- **`tsconfig.json` に `noUncheckedIndexedAccess` 追加** — コードは既に `points[i]!` スタイルで書かれており移行コストの大半は支払済み。`estimateTextObjectSize` 系の実バグを型で拾える。
- `rounds.ts` の `Record<string, unknown>`+`String()` 運用 → scriptManga.ts の RunRow/TaskRow 同様の行型定義へ。
- `BEAT_KIND_GLYPHS` を `Record<BeatKind, string>` に(kind追加時の黙殺フォールバック防止)。

### 性能
- `getScriptMangaRun` の N+1(recover×3フルスキャン+task毎の asset 実在チェック等、480コマ級 run でポーリング毎に数千クエリ)→ `WHERE id IN (...)` 集約。
- `db.ts:897-910` — `runSql`/`getRow`/`getRows` が毎回 `prepare`(bun:sqlite の文キャッシュは `db.query()` 側)。`query()` へ置換で全DBアクセスのパース費用削減。
- `maskEditorController.ts:75-130` — 毎render無条件の canvas.width 代入+全層再合成。変化時のみ実行に。
- `inheritSelectedTasks` の panel マップ4回フルスキャン → 1クエリから導出。

---

## 4. デッドコード
- `provider.getStatus`(comfyProvider/fakeProvider)— インターフェース必須メンバだが未配線(「ポーリングフォールバック」コメントに反する)。
- `views/pagePanelLightboxView.ts:417-425 renderSelectToolbar` — 参照0(旧コマモードタブ遺物)。
- `openRasterExport.ts:344-361` — 到達不能2分岐(上記MEDバグと同一箇所)。
- `scriptMangaDirector.ts` — 非Detailed版 `planScriptMangaWithDirector` 未使用、`stylePrompt` 引数未使用。
- `preLayoutBeat.ts:172-183` — `@deprecated desiredScale`/`BEAT_SCALES` の削除予定残骸。
- `mangaEffects.ts:12-39` — `inferMangaEffect`/`createMangaEffectObjects` はテスト以外未使用。
- `appState.ts:160 baseVersion` — write-only(C7 の修正で本来の用途に使うべき)。
- export過剰 約130件(ファイル内でのみ使用)— `export` 剥がしでモジュール境界明確化。

## 5. テストカバレッジ穴
- `pageLayout.ts` — 見開き分割 / balloon/textページ帰属 / **`translateSvgPathData`(相対コマンド・Aコマンド処理、最も壊れやすい)** に直接テストなし。
- `dialogueAutoLayout.ts` — `estimateTextObjectSize` 未テスト(実際に上記バグ疑義)。本体 `runDialogueAutoLayout` は32ケースで良好。
- `pageLayoutExport.ts` — `guruguruLayoutFromPage` 直接テストなし(texts の退化box `[x,y,x,y]` バグもテストがあれば検知できた類)。

## 6. 推奨着手順
1. **HIGHバグ修正バッチ**(S1/S2 + C1〜C10)— C1/C2 は modelWorkerClient 共通化と同時に、C7/C8/C9 は3点セットで。
2. **危険重複の抽出**(buildPanelGenerationRequest / dialogueAutoLayout スコア関数 / dialogueAutoLayoutApi トランザクション)。
3. **クライアント三本柱**(debounce persister → ドラッグセッション → セッションstate再編)— MEDバグの大半がここで構造的に解消。
4. **巨大ファイル分割**(scriptManga.ts → pagePanelLightboxView.ts → routeApi テーブル化)。
5. **ユーティリティ統合+`noUncheckedIndexedAccess`+性能系**。

各段階で `bun run test`(1170件)を回帰確認。UI検証が必要な変更(ドラッグ/lightbox系)は Browser パネルで実機確認。
