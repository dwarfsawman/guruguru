# コードベース監査レポート: リファクタリング・バグ修正候補(2026-07-21)

- 監査方法: 読み取り専用の並列監査4系統(server / client / shared+横断 / 危険パターンGrepスイープ)。全所見はコード実読で裏取り済み。
- ベースライン: `bun run test` 1170件全パス(0 fail)。
- 前提: **UIの見た目・挙動・外部API仕様は不変**。内部構造のアグレッシブな刷新は可。
- **2026-07-22 追記**: リファクタ12本+HIGHバグ修正バッチが main マージ済み。各項目に対応状況を注記した(**✅=修正済み / ⏳=一部対応 / 無印=未修正**)。行番号は監査時点(分割前)のもので、分割後は移動先モジュール(scriptMangaLettering.ts、pageObjectsSidebarView.ts 等)を Grep で特定すること。MED/LOW は §2 に全件列挙済み(2026-07-22 に「主要のみ」から全量へ展開)。

---

## 1. HIGHバグ(即修正推奨)— **全12件 ✅修正済み**(S1/S2/C1/C2/C3/C6/C7/C8/C10 は HIGHバグ修正バッチ merge 13d126e、C4/C5 は dragSession/debouncedPersister、C9 はセッションリセット集約で解消)

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
- ✅ `src/server/comfy.ts:241-251` — `comfyFetchJson` が `JSON.parse` を `response.ok` 判定より先に実行。非JSONエラーボディで無関係な SyntaxError になり診断阻害。`llm.ts:242-297` は修正済み・comfy.ts のみ旧順序残存(2系統の監査で独立に検出)。**→ 安全境界マージで修正済み**。
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

### クライアント(全件。番号は監査ログの通し番号 M11〜M34)

| # | 場所 | 状態 | 内容 |
|---|---|---|---|
| M11 | `pagePanelLightboxController.ts:467-491` | 未 | `commitCropDraft` に応答順序ガードなし。連続PATCHの古い応答が後着すると `pagePanelAssignments` が古いcropで上書き。 |
| M12 | `pagePanelLightboxController.ts:804-840` | 未 | `placeDialogueLine` はPOST応答で `pageObjectsDraft` を丸ごと置換+履歴リセット。在飛中のユーザー編集が消える。 |
| M13 | `pagePanelLightboxController.ts:85-124 vs 168-216` | ✅ | open/close の stateリセット約25フィールドが非対称な手書き2連リスト(closeは freehand/marquee/selectedVertices/geometryPreview/snapGuide を触らない)。**→ resetLightboxSessionState 一元化で修正済み**。 |
| M14 | `pasteObjectController.ts:1028` | 未 | `loadingToastId` が一度も代入されない(宣言のみ、参照:1096)。「画像を読み込んでいます…」トーストが完了後も dismiss されない。`loadingToastId = pushToast(...)` の1行修正。 |
| M15 | `pasteObjectController.ts:126-141` | 未 | GET復元と編集開始のレース。復元fetchのin-flight中に画像ドロップすると、応答マージせず debounce PUT が「新規1件のみ」の全量置換になり**サーバの既存添付が消える**。`buildPasteCompositeForGeneration`(:1305)も同根で永続添付抜き合成になる。 |
| M16 | `pageMosaicController.ts:610` | 未 | `handleMosaicKeydown` が Escape を処理しない。多角形描きかけの Esc が lightboxクローズまで素通りしdraftごと閉じる(「Escはlightboxより前に」の既知教訓と不整合)。 |
| M17 | `poseEditorController.ts:1145-1149` + `poseDraft.ts:67-84` | 未 | destroy後も `modelStatus:"ready"` が永続化され、再オープン後の初回検出が必ず1回エラーになる。"downloading"等のまま永続化されると膠着。normalize で transient status をリセットすべき。 |
| M18 | `webSamController.ts:688-694` + `maskDraft.ts:61-81` | 未 | 同上のWebSAM版(`webSamModelStatus` 残留)。 |
| M19 | `poseEditorController.ts:1271-1275` | 未 | 関節ドラッグの pointercancel が `dragging` クラス除去も `requestRender()` もしない(直下の selection drag は呼ぶ)。SVG上の見た目とdraftが乖離。※poseEditor は dragSession 未移行のため残存。 |
| M20 | `webSamController.ts:552-562` | 未 | `drawCandidatePreview` に await後の assetId ガードなし。切替後アセットのキャンバスへ旧アセットのプレビュー層を合成し得る。 |
| M21 | `scriptMangaController.ts:232-237,252-256` | 未 | `candidatesBusy` の解除が serial 一致時のみ。生成中に別操作が refresh を呼び serial が進むと busy が true で固着し「候補を生成」が恒久disabled+ポーリングも停止。 |
| M22 | `views/nameStudioView.ts:194-212` | 未 | 候補の重複排除が customLayouts/balloonHints を見ないため、**人間がコマ割り修正した候補が tie-break で隠され**未修正の重複が代表になる。 |
| M23 | `views/nameStudioView.ts:786-793` | 未 | コマ割り編集セッション中も adopt(このネームで生成)/破棄ボタンが活性。未保存ドラフトを黙殺して生成へ進む/破棄でセッションだけ残る。 |
| M24 | `nameStudioController.ts:184-208` | 未 | `beginPanelEdit` が `namePoseEdit` を閉じない(逆方向は閉じる)。見開き表示で両セッション同時成立→保存で pose 側 baseVersion が陳腐化。 |
| M25 | `generationDraft.ts:52` + `views/generationPanel.ts:131-133` | 未 | txt2img実行後 `img2imgTemplateId:""` になり、`??` は空文字を素通りするため select が先頭テンプレートへ化ける。**以後の img2img がユーザー選択と違うテンプレートで走る**。 |
| M26 | `projectController.ts:21` | ✅ | ヘッダの home 遷移(`loadHome`)が `rememberActiveRoundDraft()` を呼ばず、Bookページのフォーム最終編集が per-round マップに退避されない。**→ workspaceSession 集約(stashActivePageFormDrafts 統一)で修正済み**。 |
| M27 | `generationController.ts:386-416` | 未 | `refreshProject` 自体に await後の再検証ガードなし。fetch中にページ/プロジェクト遷移すると古い detail で state を上書き。 |
| M28 | `generationController.ts:152` | 未 | poll に渡す projectId を await 後に `state.currentProjectId` から再読み。await中の遷移で新プロジェクトIDをガード基準にした旧roundのpollが走る。 |
| M29 | `generationController.ts:537` | 未 | `exportSelected` はAPIを呼ばず成功トーストだけ出す(galleryView:229 の「保存」ボタンから到達)。**ユーザーには保存されたように見える**。 |
| M30 | `generationController.ts:260` | 未 | undo失敗時に record を pop 済みのため undo/redo 両スタックから消滅し復元不能になる。 |
| M31 | `chronicleController.ts:291,343,348,390,401,441,465,555,601` | 未 | 非同期完了ガードが pageId のみで scriptId を見ない。preview 中の脚本切替で旧脚本の結果が新脚本表示へ書き込まれる。リクエスト連番トークン化を推奨。 |
| M32 | `chronicleController.ts:113-122` | 未 | 脚本切替が `preview`/`selectedBeatIds`/`previewBeatId` をクリアしない。旧脚本のプレビューゴーストと「確定」ボタンが残り、**押すと旧脚本の placementIds を現在ページへ apply**。 |
| M33 | `scriptController.ts:178-183` | 未 | `state.scripts` への push が currentProjectId ガードの前。取り込みPOST中のプロジェクト離脱で旧プロジェクトの脚本が新プロジェクトの一覧へ混入。 |
| M34 | `domMorph.ts:193-199` | 未 | `<select>` 同期で新HTMLに `option[selected]` が無いと何もしない。innerHTML全再構築時代の「先頭optionへ初期化」と意味論が異なる(現ビューでは controller 側の値書き戻しで顕在化していない)。 |

### LOWバグ(全件)

#### クライアント(監査ログ通し番号 L35〜L85+横断1件)

| # | 場所 | 状態 | 内容 |
|---|---|---|---|
| L35 | `pagePanelLightboxController.ts:137-139` | 未 | open の detail 応答ガードが pageId のみ。応答到着前のコマ枠編集が上書き消失(窓はfetchレイテンシ分)。 |
| L36 | `pagePanelLightboxController.ts:874-908` | 未 | 同一ページ閉→再開→再リクエストで先行リクエストの finally が busy を先に解除し後続応答が捨てられる。 |
| L37 | `pagePanelLightboxController.ts:290-309` | ⏳ | `pendingPanelSelect` の220msタイマーが close/open で clear されない(**→タイマー破棄は resetLightboxSessionState で対応済み**)。`selectPanel` が panelId の所属検証をしない点は未対応。 |
| L38 | `pagePanelLightboxController.ts:781-796` | 未 | `loadDialogueDrawerLines` のガードが projectId のみで lightbox 開閉を見ない。 |
| L39 | `pasteObjectController.ts:1033` | 未 | `wasDownscaled` が長辺ちょうど4096pxで誤true(不要な再エンコード)、`createImageBitmap` 無し環境で誤false。 |
| L40 | `pasteObjectController.ts:82-98` | 未 | debounce PUT と flush PUT の順序保証なし(全量置換PUTの逆順着弾)。※paste は debouncedPersister 未移行。 |
| L41 | `pasteObjectController.ts:1270,1317` | 未 | `pasteEnabled=false` の扱いが経路間で不整合。「ペイント結果を素材として保存」経路(`pasteLayersForAsset`)は enabled を見ず PASTE OFF でも焼き込む。 |
| L42 | `pasteObjectController.ts:212` | 未 | 画像未ロード毎に `load` へ新クロージャを once 登録し累積。アセット切替で旧オブジェクトが一瞬描かれる(次renderで自己修復)。 |
| L43 | `pasteObjectController.ts:1154,1130` | 未 | drop→fetch のネットワーク例外が未catchで unhandled rejection(トーストなし)。 |
| L44 | `pasteObjectController.ts:787` | 未 | `lastNudgeHistoryAt` がアセット横断の単一変数。切替直後のナッジで履歴が1段飛ぶ。 |
| L45 | `pasteObjectController.ts:219,1056` | 未 | `applyPendingPlacement` が位置のみ再配置し scale を再フィットしない(1×1基準の極小scaleが残るエッジケース)。 |
| L46 | `panelShapeController.ts:178` | 未 | ドラッグ中の過渡状態を debounce 保存が送信し得る+pointercancel 復元パスが再保存しないためサーバと乖離。 |
| L47 | `panelShapeController.ts:692-714` | 未 | `beginGeometryDrag` がハンドル解決前に rect/ellipse→polygon 化し、失敗時に履歴なしで polygon 化だけ残る(undo不能)。 |
| L48 | `panelShapeController.ts:1306-1347` | 未 | ドラッグ進行中の Esc がドラッグを復元せず lightbox クローズまで落ちる。 |
| L49 | `panelShapeController.ts:795` + `pageMosaicController.ts:364` | 未 | pointerdown で `event.button` を見ない(右/中クリックでドラッグ開始)。paste側は button 0 のみで不整合。※dragSession 移行時に「現状挙動維持」の方針で意図的に据え置き。 |
| L50 | `pageMosaicController.ts:76` | ✅ | startPersist 非直列化(C5 と同構造、併走窓は小)。**→ debouncedPersister 共通化で修正済み**。 |
| L51 | `pageMosaicController.ts:397,480` | 未 | 座標クランプの不整合(polygon頂点ドラッグのみページ境界クランプ、rect系とクリック追加はクランプなし)。 |
| L52 | `pageMosaicController.ts:183` | 未 | `pageHeightForLightbox` のフォールバック50は実質クランプ無効のマジックナンバー。 |
| L53 | `poseEditorController.ts:1169` | 未 | pose overlay 上の右クリック編集確定後にブラウザのコンテキストメニューが開く(contextmenu抑止が `#maskCanvas` のみ)。 |
| L54 | `poseEditorController.ts:256-267` | 未 | `posePendingDetect` が detected 受信でクリアされず、後日のモデルロード完了時に意図しない自動検出。 |
| L55 | `poseEditorController.ts:278-283` + `webSamController.ts:399-404` | 未 | 画像ロード待ちPromiseが morph での要素差し替えで永遠に未解決(同型コピペ2箇所)。 |
| L56 | `maskEditorController.ts:659` + `webSamController.ts:62` | 未 | `setPointerCapture` がこの2箇所だけ try/catch 無し(他は全箇所ガード)。throwで空振りundoエントリ。 |
| L57 | `maskEditorController.ts:703-713` | 未 | pointerup 時に `#maskCanvas` 不在だと `activeMaskStroke` が残りポインタイベントを飲み続ける。 |
| L58 | `poseEditorController.ts:748-753,1145` | 未 | `clearPoseUndo` がセッションクローズから呼ばれずコメントと実装が不一致。※mask 側(C3)は修正済み、pose 側が残存。 |
| L59 | `poseEditorController.ts:875-889` | 未 | `beginPoseSelectionDrag` が検証前に `selectedPoseEdges` を代入し、early return 時に再renderされない不整合。 |
| L60 | `namePoseEditController.ts:253` + `nameStudioController.ts:263` + `nameLayoutEditController.ts:186` | 未 | 保存成功時に無条件で state を null 化。save の await 中に cancel→新セッション開始すると新セッションを破壊(3箇所同型)。 |
| L61 | `nameStudioController.ts:74-76` | 未 | アクティブテイク解決がビュー(distinct後)と controller(全候補先頭)で不一致。takeId が非表示候補を指し得る。 |
| L62 | `views/nameStudioView.ts:751-753` | 未 | フリップ済みページで diff署名(layoutTemplateId込み)が一致せず「この頁は候補間で異なる」ノートが消える(low-med)。 |
| L63 | `nameStudioController.ts:336-355` | 未 | 編集セッション中の矢印キーでページ送りされ、編集UIだけ消えて不可視セッション(Ctrl+Z含む)が残る(low-med)。 |
| L64 | `nameStudioController.ts:225` | 未 | `draft.shotSize as NonNullable<...>` 無検証キャスト。 |
| L65 | `views/nameStudioView.ts:342` | 未 | `plan.pages[page.index - 1]` の位置アクセス(同関数内:349は find で防御しており不統一)。外部提供プランで index≠配列位置だと誤評価。 |
| L66 | `generationController.ts:248` | 未 | redo 1回で `roundDeletionRedoStack` が全クリアされ2件目以降の redo が効かない。 |
| L67 | `generationController.ts:88` + `projectController.ts:113` + `generationController.ts:844` | 未 | `form.seed ? ... : null` は `"0"` を未指定扱い。`randomSeed()` は0を生成し得る(3箇所複製)。 |
| L68 | `projectController.ts:435` | 未 | インポート直後のプロジェクト一覧カウントが常に0/1でリロードまで虚偽表示。 |
| L69 | `bookController.ts:229` | 未 | 画像一括インポートのループが await 後に `state.currentProjectId` を再読みし、離脱で `/api/projects/null/...` へPOST。 |
| L70 | `bookController.ts:76` | 未 | `openPage` の out-of-order レース(遅いレスポンスのページが勝つ)。`openBook`/`openProject` も同型。 |
| L71 | `projectController.ts:47-51` + `bookController.ts:31-32` | 未 | fetch成功前に `currentProjectId` を確定。失敗時に中途半端な state。 |
| L72 | `bookController.ts:340` | 未 | ページ削除時に `generationDraftsByRound`/`roundProgress`/round削除undoスタックの掃除漏れ。残ったundoをCtrl+Zすると404。 |
| L73 | `generationController.ts:89,98` | 未 | `generationMode`/`seedMode` の無検証キャスト。 |
| L74 | `chronicleController.ts:455-472` | 未 | `unlockChroniclePlacement` のみ in-flight ガードなし(連打で多重発行)。 |
| L75 | `chronicleController.ts:57-105` | 未 | 同一ページの閉→即再開で新旧レスポンスの last-write-wins レース。 |
| L76 | `chronicleController.ts:343-356` | 未 | apply 成功後の pageId ガード early return で DB更新済みなのに undo履歴が積まれない。 |
| L77 | `chronicleController.ts:527-534` | 未 | ロック楽観更新が PATCH 失敗時にロールバックされない。 |
| L78 | `scriptController.ts:140` | 未 | revision の無い脚本へ切替時に前の脚本の Fountain テキストが textarea に残り、そのまま取り込める。 |
| L79 | `scriptController.ts:234-241` | 未 | binding 取得失敗時に LoRA ドラフトが前キャラの値のまま。 |
| L80 | `paintEditorController.ts:35,44,530` | 未 | wheelズームの pending がアセット横断+クローズ時にタイマー未破棄(閉じた後に draft へ書き込み)。 |
| L81 | `paintEditorController.ts:271-279` | 未 | 画像load完了前の初回ストロークが 300x150 の仮レイヤーに描かれ、load後のsyncで消える+undoエントリも積まれない。 |
| L82 | `paintEditorController.ts:504` | 未 | Ctrl+Shift+Z でも undo が走る(shift除外なし)。 |
| L83 | `domMorph.ts:73-78` | 未 | 重複data-key未検知(片方の内容が無警告で消える)。開発時warn推奨。 |
| L84 | `pageObjectsController.ts:882-888,927-933` | 未 | `updateBoxContentField`/`updateBalloonContentField` が `nextStyle` の同一性を比較せず常にcommit(`updateTextOwnField` は比較する)。no-op変更でも履歴エントリ+PATCHが発生し得る非対称。 |
| L85 | `pageObjectsController.ts:212-236` | 未 | `persistPageObjects` 失敗時は toast のみで再試行なし・`objectsDirty` も立たない。クローズ時のプレビュー再取得判定からも漏れる。 |
| L86 | `maskEditorController.ts:108` | 未 | `void ensureMaskLayerSet(...).then(...)` に `.catch` がなく、レイヤ画像のロード失敗時に unhandled rejection(UI通知もなし)。※横断スイープで検出。 |

#### サーバー(監査ログ §A の low / low-med。S1/S2 は §1 で修正済み)

| # | 場所 | 状態 | 内容 |
|---|---|---|---|
| SL1 | `scriptManga.ts:1084-1095`(現 scriptMangaLettering/Materialize 周辺) | 未 | 【low-med・§2サーバーMEDにも記載】fill unit の `dialogue_lines` INSERT で `order_index` が全 unit 同値(`1_000_000 + fillUnits.size`、ループ不変)+snapshot 側(`1_000_000 + unit.part`)と食い違い。`status='active'` のため次回 `loadActiveDialogues` が fill 由来行を通常台詞として拾う(データ汚染)。 |
| SL2 | `storage.ts:16,101-124` | 未 | 【low-med・§2サーバーMEDにも記載】`thumbnailRepairTasks` が成功エントリを削除せず無制限成長+「修復済み」記憶でファイル再消失時に再起動まで再修復されない。 |
| SL3 | `storage.ts:422-439` | 未 | `readImageSize` の JPEG 走査が境界チェック無しで `readUInt16BE`。切り詰められた JPEG で RangeError がそのまま 500。SOF マーカー判定も 0xC0-0xC3 のみで SOF5-7/9-11/13-15 を見逃す。 |
| SL4 | `rounds.ts:638-651` | 未 | `parentAssetDimensions` が image_path の存在検証なしに readFile。width/height 未記録の旧アセットでファイル欠損だと ENOENT が生の 500(400系に包むべき)。パス検証(isPathInside)も無し(DB由来でリスク低)。 |
| SL5 | `scriptMangaPlanCandidates.ts:751-763,848-859` | 未 | set-layout / set-custom-layout の CAS UPDATE(`WHERE ... AND edit_version = ?`)の `changes` を未検査のまま成功応答。現在は全体が同期なので実害なしだが、将来 await が挟まれば lost update。同ファイルの adoption 系は検査しており不統一。 |
| SL6 | `index.ts:341-347` | 未 | PUT /api/settings/vlm-audit で `modelKey` の既定が `current.modelKey ?? current.model` のため、model だけ変更して modelKey 未送信だと旧 model 名が modelKey に固着(UI が常に両方送るなら顕在化しない)。 |
| SL7 | `scriptManga.ts:444-462`(現 scriptMangaSubmission.ts) | 未 | 【仕様確認】`panelGenerationSize` は family="sdxl" のとき config.longEdge を完全に無視(SDXLバケット固定は意図的と思われるが未コメント)。 |

#### shared(監査ログ通し番号 3〜11)

| # | 場所 | 状態 | 内容 |
|---|---|---|---|
| SH3 | `pageLayout.ts:318 vs :358` | 未 | クランプ境界の不整合。`clampPanelCrop`/`normalizePanelCrop` は width/height 下限 0.01 を許すが、`scaleCropAboutCenter` の下限は `MIN_CROP_ZOOM_SIZE`=0.05。API/DB 経由で 0.01〜0.05 の crop が正当に保存でき、最初のズーム操作で勝手に 0.05 へ広がる。 |
| SH4 | `pageLayout.ts:608-616` | 未 | `resolveAspectRatio` で `firstPage.height` が有限だが 0 以下の場合、既定 1.4142 ではなく `[1,1]`(正方形)へフォールバック。1.4142 の既定は「height が非数」の場合にしか効かない。 |
| SH5 | `dialogueAutoLayout.ts:620-624,698-701` | 未 | `preferredPanelId` が現在のレイアウトに存在しない(コマ削除後など)場合 `panelIndex=null` となり、警告文言が「このページにコマが無いため配置できませんでした」になる誤誘導。 |
| SH6 | `mangaPlanV2.ts:365-378` | 未 | `validBox` は上限側のみ許容誤差(`<= 1.000001`)で下限側(`x >= 0`)は厳密。浮動小数ノイズで -1e-9 になった bbox は reject される非対称。 |
| SH7 | `dialogueAdaptation.ts:47` | 未 | `splitDialogueUnits` は空文字入力で `parts=[""]` となり、text が空の DialogueUnit を1件返す(呼び出し側で空吹き出しになりうる)。 |
| SH8 | `poseRegion.ts:23-30` | 未 | `poseBodyScale` は neck/両hip の `visible` を確認せず座標を使う。不可視関節(back-view プリセット等)の座標が体格スケールに混入しうる。フォールバック側(:31以降)は visible を見ており不整合。 |
| SH9 | `pageLayoutExport.ts:204-212` | 未 | 自由 TextObject の SPEC 出力 `box` が `[x, y, x, y]`(幅高さゼロの退化矩形)。balloons 側は外接矩形を出しており、texts 側だけ範囲情報が失われる。 |
| SH10 | `scriptMangaProvidedPlan.ts:148` | 未 | ページ index 検証が `index===pageIndex || index===pageIndex+1` のためページ毎に 0始まり/1始まりを混在受理(`[1, 1]` のような並びも通る)。実害小だが検証として緩い。 |
| SH11 | `pageLayout.ts:245-255` | 未 | `panelBounds` の path フォールバックは d 内の全数値を (x,y) ペアとして拾うため、A(arc) コマンドの rx/ry/フラグも座標扱い(コメントで best-effort と明記済み。bezier 付き path は正確)。 |

※shared の MED 2件(`estimateTextObjectSize` / `externalScriptMangaLayouts`)は上の「shared」節参照。

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
