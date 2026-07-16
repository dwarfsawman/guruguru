# Plan: ネームリーダーUI — テキストネームの比較・選択・編集(人間参加ゲート)

> 状態: **[Plan-NameStudioV5.md](Plan-NameStudioV5.md) に置換(2026-07-16)**。互換性を要求しない方針転換により、
> 本計画のUI部(D1/D2/D3/D4/D5)はV5のD5〜D7へ吸収された。実装時の要注意点(既存panelBounds・座標系・
> PATCH同期materialize・domMorph保護範囲・採用前提条件)はV5からも参照される。
> (旧状態: 計画・承認待ち、2026-07-16 起票)
> 前提仕様: [Plan-MangaNameV4.md](Plan-MangaNameV4.md)(P1〜P4・P6 実装済み。特に D3 候補比較UI)、
> [Feature-MangaPlanV2.md](Feature-MangaPlanV2.md)、[Reference-ScriptMangaAgentWorkflow.md](Reference-ScriptMangaAgentWorkflow.md)、
> [Reference-AgentInstanceApi.md](Reference-AgentInstanceApi.md)。

## 目的

コマ割り候補を「ワイヤーフレームの見た目」ではなく**テキストネームとして読んで**選べるようにする。
人間が判断したいのはテンプレートの幾何形状ではなく「このコマで何を見せるのか」「どこで溜めてどこで大きく見せるのか」
「台詞量に対してコマが狭すぎないか」だから、紙のネーム(コマ枠+コマ内テキスト)に近い形式で提示する。

ネームは二段階で見せる。

1. **構造ネーム(候補採用前)** — 読み順番号・コマの大小・ビート種別・内容1〜2行・台詞量。候補比較と選択に使う。
   カメラや感情はまだ決まっていない(監督は採用後に走る)ので出さない。
2. **演出ネーム(採用後・生成前)** — カメラ(shot/angle)・構図・人物(表情/行動)・台詞本文。確認と修正に使う。

あわせて、**自動化エージェントが script-manga パイプラインを進めている間も、人間が同じ localhost ページを開いて
候補の到着をライブで眺め、UIで選択・編集し、エージェントがそれを待ち合わせられる**ようにする。

方針は複雑化を避けること。**DBスキーマ変更なし・サーバー変更は additive な小拡張のみ(P3の未演出マーカー1フィールドと
P5任意項目)・プッシュ配信なし**で、既にクライアントへ届いているが未描画のデータを描画し、足りないのはクライアントの
ポーリングループと運用ドキュメントだけ、という構成にする。

## 現状(調査結果、2026-07-16 時点の main)

### 既にあるもの

| 資産 | 根拠 |
| --- | --- |
| 候補比較セクション(グループ毎カード横並び、ワイヤーフレームサムネ64px、importance塗り・台詞量バー・ビートkindグリフ・▼turnHook・候補間diff枠) | `src/client/views/scriptView.ts` `renderPlanCandidatesCard`(~482)/`candidatePageThumb`(~396)、`src/shared/pageLayoutSvg.ts` `renderPageWireframeSvg`(:185) |
| **構造ネームに必要なデータは全てクライアント着済み** — 候補の `plan` は完全な `ScriptMangaPlan` で、コマ毎 `sourceText`/`dialogueOrderIndexes`/`importance`/`sourceBeatIds`、ページ毎 `pageIntent`/`turnHook`/`layoutTemplateId` を含む。envelope に `beatKinds`(beatId→kind)と `dialogueCharsByOrderIndex` | `src/shared/scriptMangaApi.ts` `ScriptMangaPlanCandidateView`(:62-79)/`ScriptMangaPlanCandidatesResponse`(:81-87)、`src/shared/scriptMangaPlan.ts`(:22-45) |
| **演出ネームに必要なデータもクライアント着済み** — `ScriptMangaRunView.plan`(MangaPlanV2)に `shot{size,angle,focalSubjectId,compositionIntent}`・`cast[]{characterId,bbox,expression,action,gazeTarget}`・`promptBase`・`dialogueSnapshots`(台詞本文)・`narrativeGraph.entities`(人物名)・`layoutSnapshot`。**現在は一切未描画** | `src/shared/scriptMangaApi.ts:135-162`(`planId` :141)、`src/shared/mangaPlanV2.ts`(PanelSpec :155-196) |
| 採用フロー — 「この案で生成」→ `POST /api/projects/:id/script-manga-runs` + `planCandidateId`(generateImages:false 固定)。サーバー側で監督(lockLayouts:true)→V2→materialize が同期実行され、候補は `status='adopted'`+`adopted_run_id` になる。以降は 承認→生成開始 ボタン | `src/client/scriptMangaController.ts` `adoptCandidate`(:239)、`src/server/scriptManga.ts`(:3049-3199)、`src/server/scriptMangaPlanCandidates.ts` `markPlanCandidateAdopted`(:244) |
| 採用後プランの全編集API — `PATCH /api/script-manga-plans/:planId`(完全な MangaPlanV2 を受け、承認済み/実行中/候補レビュー中(awaiting_review)は409、決定的再検証422、run を preparing へ戻して**同期で**再materialize。レスポンスは `ScriptMangaPlanView`)。`materializeRun` が `compiledPrompt` を再コンパイルするので **`promptBase`/cast/shot の編集は生成へ反映される** | `src/server/scriptManga.ts` `updateScriptMangaPlan`(:3207-)、再コンパイル(:1346)、route `src/server/index.ts:657-665` |
| ライブ再描画の下地 — 状態変更+`requestRender()`→keyed DOM morph(フォーカス/スクロール保護)。ポーリングループの先例 `pollCollectRound`(delay-loop+世代ガード) | `src/client/domMorph.ts`、`src/client/generationController.ts`(:286) |
| モーダルの先例 — 全画面オーバーレイ+`main.ts` クリックハンドラ先頭の背景クリック判定(優先順)+Escape。大型ステートフルlightboxの参照実装は `pagePanelLightboxView.ts` | `src/client/main.ts`、`src/client/views/pagePanelLightboxView.ts` |
| ページ共有の下地 — UIとAPIは同一サーバー同一ポート。ユーザーインスタンス(5177)は `HOST` 未指定なら全インターフェースbind(表示ログの127.0.0.1は飾り)。エージェントインスタンス(5199)は `start-agent.mjs` が `HOST=127.0.0.1` を強制(env `HOST` で上書き可) | `src/server/index.ts:132-133`、`scripts/start-agent.mjs` |
| エージェント待ち合わせの下地 — 候補一覧 `GET /api/projects/:id/script-manga-plan-candidates?scriptId=` は採用済み候補も返す(archived除外・最新revisionのみ)ので、**ポーリングだけで人間の採用を検知できる**。run の `approvalStatus` も `GET /api/script-manga-runs/:id` で見える | `src/server/scriptMangaPlanCandidates.ts` `listScriptMangaPlanCandidates`(:130-140) |

### 無いもの(このプランで埋める)

| # | ギャップ |
| --- | --- |
| N1 | 候補のコマ内テキスト表示が無い。`sourceText`・`pageIntent`・台詞件数は届いているのに、視覚エンコード(バー/グリフ)とツールチップだけ。ページ拡大も無い |
| N2 | 演出(監督出力)の表示UIが皆無。`grep pageIntent\|compositionIntent\|promptBase` は src/client でゼロ件。run カードは件数と警告のみ |
| N3 | 演出の編集UIが無い(APIは既存。UIが whole-plan PATCH を組み立てる先例が無い) |
| N4 | script画面のライブ更新が無い(SSE/WebSocket/setInterval とも存在せず、更新は手動ボタン。放置ブラウザは何も映さない) |
| N5 | エージェント併走時の「人間のネーム選択を待つ」手順が未文書化(現行 Reference-ScriptMangaAgentWorkflow.md は人間ゲート無しでエージェントが自分で採用・承認する前提) |

## 人間の操作フロー(全体像)

```
エージェント(またはUI): 候補生成 POST script-manga-plan-candidates
        ↓                                   ── 人間は共有URLの script 画面を開いておく(ライブ更新 D2)
人間: 候補カードを見比べ → コマ枠サムネをクリック → 構造ネームリーダー(D1)で読む
        ↓ 「この案で生成」(採用 = 既存ボタン。監督が1回走る)
人間: 演出ネームリーダー(D4)でカメラ・人物・台詞を確認、必要ならコマ詳細を編集(D5)
        ↓ 「承認」(既存ボタン)
エージェント: 採用・承認をポーリングで検知(D3) → 生成開始 → 画像候補レビューへ(既存フロー)
```

採用(候補選択)と承認(演出確認後のGO)という**既存の2つの人間ゲートをそのまま使う**。新しい状態遷移は作らない。

## 設計

### D1. 構造ネームリーダー(候補採用前)

**方針: 既存カードUIは置換せず、クリックで開く全画面リーダーを足す。SVGワイヤーフレームは背景、テキストはHTMLオーバーレイ。**
長文をSVG内で折り返すのは複雑化のもとなので、コマのbboxに絶対配置したHTML箱に書く(添付ネーム画像と同じ見た目の方向)。

1. **入口** — 候補カードのページサムネに `data-action="open-name-reader"`(+candidateId/pageIndex)。カードに「リーダーで読む」ボタンも追加。
2. **画面構成** —
   ```
   ┌──────────────────────────────────────────────┐
   │ 候補B ビート化N1 cinematic T=0.35   p3/12  [◀候補][候補▶] [✕] │
   ├──────────────────────────────────┬───────────┤
   │  ページ大表示                       │ (D5で使用。 │
   │  ┌────────────────────────┐      │  D1では     │
   │  │ ① 大 ★hero  [reveal]     │      │  非表示)    │
   │  │ 内容: 炎上中の配信サムネ…   │      │            │
   │  │ 台詞 1件 / 12字            │      │            │
   │  ├───────┬────────────────┤      │            │
   │  │ ② 中 [action]│ ③ 小 [pause] │      │            │
   │  └───────┴────────────────┘      │            │
   ├──────────────────────────────────┴───────────┤
   │ ページ意図: 無気力な日常から主人公の顔へ寄る   めくり: ▼reveal │
   │ [◀前ページ]  [次ページ▶]        [この案で生成] [アーカイブ]     │
   └──────────────────────────────────────────────┘
   ```
3. **コマ内テキストの中身(構造ネーム)** — すべて既存データから合成する(**自由記述の保存はしない**。正はあくまで plan/beat):
   - 読み順番号: `orderPanelsByReadingDirection` の順(plan panels 配列と同順の既存不変条件を利用)
   - 大きさクラス **大/中/小**: レイアウトスロットの実面積割合から決定的に算出(閾値は未決#1。例 大≥0.38/中≥0.15)。
     `importance` の hero=★キメゴマ / splash=見開き級 はバッジで併記(small はパネル側に無いので面積で代替)
   - ビート種別: `sourceBeatIds`→`beatKinds` のチップ(setup/action/reaction/reveal/decision/transition/pause)。
     注釈がフォールバック(非キャッシュ)のときは空になるので非表示で劣化
   - 内容: `sourceText` を先頭~100字で行クランプ(hero/splashは箱が大きいので自然に多く見える)
   - 台詞: `dialogueOrderIndexes.length` 件+`dialogueCharsByOrderIndex` 合計字数
   - **決定的フォールバック候補は importance/sourceBeatIds/pageIntent/turnHook を一切持たない** → バッジ・ビートチップ・
     ページフッターとも非表示で劣化(renderスナップショットに決定的候補ケースを含める)
4. **幾何** — **既存の shared `panelBounds(shape)`(`src/shared/pageLayout.ts:217`、rect/polygon/ellipse/path対応)を流用**し、
   %変換とbleedクランプだけ薄いヘルパーを足す。座標系は width相対で y∈[0, page.height](内蔵プリセットは高さ≈1.414)なので
   `left=x1×100% / top=y1÷page.height×100%`、コンテナは `aspect-ratio: 1 / page.height`。bleed系はboundsが[0,1]を超える
   (−0.015〜1.015)ためページ矩形へクランプ。SVG本体は既存 `renderPageWireframeSvg` をそのまま流用(塗り・バー・グリフは背景として残す)。
5. **候補切り替え** — ヘッダの[◀候補][候補▶]で同ページ番号を保って隣の候補へ(ページ数差はクランプ)。候補間diffページは
   既存 `candidatePageSignature` の結果をヘッダに「この頁は候補間で異なる」表示。
6. **状態** — `state.nameReader: { open, mode: "candidate" | "directed", candidateId?, runId?, pageIndex, selectedPanelId? }`。
   新設 `src/client/views/nameReaderView.ts`(純関数レンダラ)+`src/client/nameReaderController.ts`(`registerActions`/`registerEventBinder`)。
   main.ts へはレンダー領域1つ・背景クリック優先順1行・Escape処理を追加(**新data-*属性の委譲条件漏れに注意** — 既知の罠)。
   CSS新設 `src/client/styles/name-reader.css`(index.cssへ@import。workflow-modal系gridを継承する場合は grid-template-rows の罠に注意)。

### D2. script画面のライブ更新(ポーリング)

**方針: プッシュ配信は作らない。`pollCollectRound` と同型の delay-loop を1本足すだけ。**

1. `pollScriptMangaStatus()` — `scriptScreenOpen && activeScript` の間、既定5秒毎(未決#5)に
   `GET script-manga-plan-candidates` と(runがあれば)`GET script-manga-runs/:id` を取得して状態を差し替え→`requestRender()`。
   世代ガード(serial+screenOpen+scriptId 照合)は既存 `refreshScriptMangaCandidates` と同じ流儀。`document.hidden` 中はskip。
   加えて2点:
   - **run のブートストラップ**: `state.scriptMangaRun` は採用を実行したブラウザにしか無い。眺めているだけのブラウザでも
     run カードが現れるよう、run未保持かつ adopted 候補に `adoptedRunId` があればそれを GET して初期化する
   - **busy中の適用抑止**: `scriptMangaBusy`(採用・承認等の操作中)の間に返ってきた poll 応答は破棄する(巻き戻り表示防止)
2. **編集との競合** — リーダーの編集ドラフト(D5)は `state.nameReaderDraft` に持ち、**編集フォームの値は常にドラフトから
   レンダーする**(DOM morph のフォーカス保護は「今フォーカス中の1要素」しか守らないので、セーフティネットにしない)。
   ポーリングは candidates/run の状態だけを差し替え、ドラフトへは触らない。編集中(ドラフトdirty)は run の適用をskipして
   ヘッダに「更新保留」を出す。
3. これで**エージェントがAPIから候補を追加すると、開きっぱなしのブラウザに候補カードが生えてくる**。runの進行(preparing→
   prepared→awaiting_approval→…)も自動で映る。既存の手動更新ボタンは残す。

### D3. ページ共有とエージェント待ち合わせ(コード変更なし、ドキュメントのみ)

1. **共有方法**(Reference-AgentInstanceApi.md へ追記) —
   - ユーザーインスタンス(5177)は既定で全インターフェースbind済み。LAN/TailscaleのIPで `http://<host>:5177` を開くだけ。
   - エージェントインスタンス(5199)は既定loopback。共有時は `HOST=0.0.0.0`(またはTailscale IP)を付けて `bun run start:agent`。
   - 注意: dev-hot.mjs のライブリロードsnippetは127.0.0.1固定なのでリモート閲覧者にはリロードが効かない(本番buildの
     エージェントインスタンスには無関係)。5177 の起動・停止は常にユーザー操作(既存の予約ルール)。
2. **人間ゲート付きエージェント手順**(Reference-ScriptMangaAgentWorkflow.md へ新節「ネーム選択の人間ゲート」) —
   ```
   0. 前提チェック(URL案内より前にエージェントが確認):
        - workflow template が作成済み(採用ボタンは templateId 未設定だと disabled)
        - キャラの reference set が承認済み(採用POSTは requireReferenceSets:true 固定。
          未整備だと materialize が blocked で 422 になり人間側の採用が成立しない)
   1. POST /api/projects/:id/script-manga-plan-candidates {scriptId, count:3, ...}   ← 候補提示
   2. 人間へ script 画面のURLを案内(以後エージェントはネームに触らない)
   3. GET 同エンドポイントを15〜30秒毎にポーリング:
        - いずれかの candidate.status === "adopted" → adoptedRunId を「即座に」記録して次へ
          (採用済み候補も人間が破棄でき、破棄されると一覧から消えて runId の再取得手段が無い。
           run一覧APIは存在しない)
        - 人間がUIで追加生成した候補が増えても構わず待つ
        - 空リスト化・既知候補idの消失(=人間が脚本を再importしてrevisionが進んだ)なら候補を作り直して再提示。
          ※一覧GETは409を返さない。409(stale candidate)は採用APIを自分で叩くunattended経路でのみ起きる
   4. GET /api/script-manga-runs/:runId をポーリング:
        - approvalStatus === "approved" になるまで待つ(この間、人間が演出ネームを確認・編集している)
   5. POST /api/script-manga-runs/:runId/start → 以降は既存の生成・レビューフロー
   ```
   採用runの生成設定(template等)は、採用ボタンを押すブラウザ側の script 画面設定が使われることを明記する
   (エージェントは手順2の案内時に必要な設定値を人間へ伝える)。無人運転(現行どおりエージェント自身が採用・承認)も
   引き続き可で、attended/unattended を節の冒頭で使い分けとして書く。

### D4. 演出ネームリーダー(採用後・閲覧)

**方針: D1と同じリーダー(mode:"directed")で、データソースを `run.plan`(MangaPlanV2)へ切り替えるだけ。**

1. **入口** — runカード(prepared/awaiting_approval時)に「演出ネームを確認」ボタン。採用直後に自動で開くかは未決#2。
2. **コマ内テキスト(演出ネーム)** — 添付ネーム画像の粒度。すべて `PanelSpec` から:
   - カメラ: `shot.size` × `shot.angle`(日本語ラベル: wide=引き, close-up=寄り 等の固定辞書)
   - 構図: `shot.compositionIntent`
   - 人物: `cast[]` を `narrativeGraph.entities` で名前解決し、`表情/行動`(expression/action)と位置(bboxの9分割近似)を1行ずつ
   - 台詞: `panel.dialogueLineIds` → `dialogueSnapshots`(id照合)の**本文**を枠付きの箱で表示(画像左の台詞枠と同じ見た目。
     `dialogueOrderIndexes` は互換フィールドなので使わない)
   - prompt: `promptBase` は details 折りたたみ(既定閉)
   - **未演出コマ(監督バッチフォールバック)の検知**: V2ビルダーは direction 欠落コマにも既定値(medium/eye-level/既定構図文)を
     必ず埋めるため、**フィールド欠落では判別できない**。`buildMangaPlanV2` で direction の有無を additive な optional
     フィールド `PanelSpec.directed?: boolean` として残す(本計画唯一のサーバー変更。validator既存契約は不変)。
     `directed === false` のコマは「未演出」バッジ+既定値をグレー表示。既存プラン(フィールド無し)は演出済み扱い
3. ページフッターは `pageIntent`/`turnHook` と `validation` のページ関連warning。レイアウトは `layoutSnapshot` を使う(不変スナップショット)。

### D5. 演出ネーム編集(構造化フィールド+whole-plan PATCH)

**方針: 自由記述の巨大テキストを保存しない。編集は構造化フィールド単位、保存は既存 PATCH に完全な MangaPlanV2 を渡す round-trip。
サーバー変更なし。**

1. **編集対象(初期)** — コマ選択→右サイドパネルで:
   `shot.size`(5値select)/`shot.angle`(6値select+**既知6値以外の現値は「その他(現値保持)」で温存** — V2のangleは自由stringで
   フォールバック由来の値が入り得る)/`shot.compositionIntent`(1行text)/`promptBase`(textarea)/
   `cast[].expression`・`cast[].action`(1行text)/ページの `pageIntent`(1行text)。cast の bbox/pose、台詞割当の移動、
   レイアウト変更は**対象外**(スコープ外参照)。
2. **保存** — 純関数 `applyNameReaderDraft(plan, draft): MangaPlanV2`(未編集フィールドは構造的に温存)で新planを組み、
   `PATCH /api/script-manga-plans/:planId`(planId は `run.planId`)。再materializeは**PATCHハンドラ内で同期実行**される
   ので「再構成中」表示は不要(送信中のビジー表示で足りる)。レスポンスは `ScriptMangaPlanView`(runビューではない)で、
   サーバーがmaterialize時にplanを正規化して書き戻す(cast整理・prompt再コンパイル等)ため、**表示はレスポンスのplanを正とし、
   runは続けて `GET /api/script-manga-runs/:id` で再取得**する(runはprepared/承認待ちへ戻る=再承認が必要)。
   - 409(承認済み/実行中/候補レビュー中)→ リーダーを読み取り専用へ(承認後の編集はさせない。既存契約どおり)
   - 422(検証失敗)→ toast+ドラフト保持(人間が直して再保存)
3. **編集の正** — `direction`(監督の8種shot語彙)はV2境界で5種へ畳まれて破棄済みなので、**編集はV2の `PanelSpec` 語彙で行う**
   (それが生成に使われる永続の正)。監督語彙の再露出はしない。

### D6. 任意拡張(P5、実装は保留可)

- 候補envelope へ `beatScales`/`beatImportance`(beatId→desiredScale/importance)を追加(サーバー小変更)。
  構造ネームの大きさ表示を「ビートの希望」と「実面積」の2行にできる(希望と現実の乖離が見える)
- 候補レベルの決定的warning: コマ面積割合×台詞字数の可読性ヒューリスティック(`DIALOGUE_BAR_FULL_CHARACTERS`=120 を基準。
  現在module-private constなのでexport化が必要)をリーダーとカードsummaryへ表示

## スコープ外(シンプル化のため明示的にやらない)

- 候補プラン自体の構造編集(ビートの移動・コマ分割/統合・レイアウト差し替え) — 選択は候補単位
- ページ単位の「いいとこ取り」(同一ビート範囲のページ差し替え) — 将来。内部互換判定は `candidatePageSignature` が既にある
- 採用・破棄履歴からのランキング学習(V4 P5連動) — データは既に貯まっている(status/adopted_run_id)
- SSE/WebSocket プッシュ配信 — ポーリングで足りる規模
- DBスキーマ変更・新テーブル
- QAで挙げたパイプラインリファクタ(importance/desiredScale の visualScale 統一、監督schemaからの layoutTemplateId 削除、
  `selectScriptMangaLayoutId` の top-k `rankLayouts` 化) — **本計画はこれらに依存しない**。UIが先に入ると
  「ビートの束ね方が悪いのか、レイアウト選択が悪いのか、説明不足なのか」を人間が切り分けられるようになり、
  リファクタの優先度判断の材料になる(別計画として起票する)

## 実装フェーズ

| フェーズ | 内容 | 主対象 | 規模 | 依存 |
| --- | --- | --- | --- | --- |
| P1 | D1: 構造ネームリーダー(lightbox・HTMLオーバーレイ・候補/ページ切替・採用導線) | `nameReaderView.ts`(新) `nameReaderController.ts`(新) `name-reader.css`(新) `appState.ts` `main.ts` `scriptView.ts`(既存shared `panelBounds` 流用+%変換/クランプヘルパー) | 中 | なし |
| P2 | D2+D3: script画面ポーリング+共有/人間ゲートのドキュメント | `scriptMangaController.ts` `Docs/Reference-ScriptMangaAgentWorkflow.md` `Docs/Reference-AgentInstanceApi.md` | 小 | なし(P1と並行可) |
| P3 | D4: 演出ネームリーダー(閲覧)+未演出マーカー(サーバー小変更) | `nameReaderView.ts` `scriptView.ts`(runカード導線) `mangaPlanV2.ts`(`directed?` 追加) `scriptMangaPlanV2.ts` | 中 | P1 |
| P4 | D5: 演出ネーム編集(ドラフト+whole-plan PATCH round-trip) | `nameReaderController.ts` `applyNameReaderDraft`(純関数・新) | 中 | P3 |
| P5 | D6: beatScales envelope+可読性warning(任意) | `scriptMangaPlanCandidates.ts` `scriptMangaApi.ts` `nameReaderView.ts` | 小 | P1。保留可 |

推奨着手順: P1 → P2 → P3 → P4(P5は任意)。P1+P2 だけでも「エージェント併走ページをライブで眺めてリーダーで読んで選ぶ」
という当初目的は満たせる。

## 変えないこと

- 候補・run・plan の既存APIとDBスキーマ(サーバー変更はP3の `PanelSpec.directed?` additive追加とP5任意拡張のみ。
  既存フィールド・validator契約・ルートは不変)
- 採用=候補選択、承認=生成GO という既存の人間ゲート(**候補採用の最終決定は常に人間** — V4の不変条件を強化する方向)
- 採用候補のページ割り・レイアウトを監督が変更できない契約(lockLayouts)
- 既存の候補カードUI(リーダーは追加であって置換ではない。サムネの視覚エンコードも維持)
- コマ内テキストは構造化データからの合成表示(自由記述ネームの保存はしない)
- ポート5177の予約ルール(Claude/エージェントはbind・kill・接続しない。検証は preview_start の autoPort)

## 未決事項

1. **大/中/小の面積閾値** — 仮: 大≥0.38 / 中≥0.15 / 小<0.15。スナップショットテストで固定し、実ネームで調整
2. **採用直後に演出ネームリーダーを自動で開くか** — 開く方が流れは良いが、監督失敗(未演出)時の見え方と合わせて実装時に判断
3. **cast編集の範囲** — 初期は expression/action のみ。bbox(位置)編集はポーズCN(V4 P4)との整合が要るので保留
4. **ステージ1の台詞本文表示** — `sourceText` に台詞本文も含まれるため初期は統合表示。分離表示するなら台詞要素の
   クライアント側入手経路(script parsed doc)の確認が要る
5. **ポーリング間隔** — 既定5秒+`document.hidden` skip で開始。エージェント側の待ちポーリングは15〜30秒を推奨値として文書化
6. **リーダーのページ送りとRTL** — ボタンは「前/次ページ」表記で開始。右綴じの左右キー割当(←=次 が自然か)は実装時に確認

## 検証

- 各フェーズ完了時: `bun run typecheck`、`bun test`、`bun run check`
- 新規テスト(純関数中心、既存 `scriptView.test.ts` の流儀):
  - %変換/クランプヘルパー(rect/polygon、y÷page.height変換、bleedクランプ)と大/中/小クラス分け(閾値スナップショット)
  - 構造ネームリーダーのrenderスナップショット(hero/splash/ビートチップ有無・beatKinds欠落時の劣化・
    **決定的候補=importance/pageIntent/turnHook無しの劣化**)
  - `buildMangaPlanV2` の `directed?` マーカー(監督成功コマ=true相当/バッチフォールバックコマ=false、既存契約不変)
  - 演出ネームリーダーのrenderスナップショット(**`directed:false` の未演出コマを含むページ**、`dialogueLineIds` での
    台詞本文解決、entities名前解決)
  - `applyNameReaderDraft` の構造温存(編集フィールド以外がdeep-equal、dialogueSnapshots/provenanceに不触、
    angle未知値の温存)
  - ポーリングの世代ガード(screen close/script切替で停止、busy中の応答破棄、ドラフトdirty時にrun適用skip、
    adopted候補からのrunブートストラップ)
- ブラウザ実機: preview_start(autoPort)で候補生成→リーダー閲覧→採用→演出確認→編集→承認の一連。
  スクリーンショットがタイムアウトする環境では javascript_tool でのDOM検査+sharpでSVG→PNG化の既知手順を使う
- エージェント併走リハーサル: エージェントインスタンス(5199, HOST指定)に対しAPIで候補を作り、別ブラウザの共有ページで
  ライブ到着→採用→エージェント側ポーリングが adopted/approved を拾って start まで進むこと

## 変更履歴

- 2026-07-16: 初版。QA(テンプレート検索方式の議論と二段ネームUI構想)を受けて起票。現状調査(既にあるもの/N1〜N5)、
  設計D1〜D6、フェーズP1〜P5。起票時にコードベースとの突き合わせ検証済み(既存 `panelBounds` の流用、V2既定値埋めに伴う
  未演出マーカー `directed?` の追加、PATCHレスポンス/同期materializeの扱い、attended手順の前提チェック等を反映)。
