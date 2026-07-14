# Feature: Chronicle Page Flow(S5)

Fountain 脚本を持つ Book プロジェクトで、ページ編集 lightbox の下部に Chronicle バー(脚本タイムライン)を表示し、脚本区間をページへ一括割り当て → 吹き出しを seed 付き自動配置で一括生成する。

元計画(ユーザー提供の「S5 Chronicle Page Flow 実装計画」)を、既存コード調査の結果と以下の決定で改訂したものが本書。**実装エージェントは元計画ではなく本書を正とする。**

## 改訂の決定事項(2026-07-11)

1. **既存セリフドロワーと併存**する。ドロワー=個別配置、Chronicle=区間選択・一括配置・俯瞰。ドロワーの挙動は変更しない。
2. **楽観ロック(expectedPageUpdatedAt)は MVP では省略**。既存方針(lightbox を開いている本人だけが操作する前提、last-write-wins)に合わせる。apply はトランザクション+全件ロールバックのみ実装。将来課題として本書末尾に記録。
3. S1〜S4(脚本ドメイン・手動配置・LLM 提案)は**実装済み**。本機能の実ギャップは「Chronicle UI」「一括割り当て API」「seed 付き自動配置」「バルーン自動サイズ計算の結線」のみ。

## 既存コードの前提(調査済み・正確な事実)

- `dialogue_lines`(src/server/db.ts): `id, project_id, script_id?, character_id?, speaker_label, text, semantic_kind('dialogue'|'monologue'|'narration'|'sfx'), emotion, order_index, scene_index, source_hash, status('active'|orphan系), source, proposal_id, created_at, updated_at`。**source_hash / orphaned 状態は lines 側**にある(placements 側ではない)。
- `dialogue_placements`: `id, line_id, page_id, panel_id, part_index, render_kind('balloon'既定), balloon_object_id, created_at, updated_at`。`balloon_object_id = NULL` は「ページ割り当て済み・未吹き出し化」を意味する(本計画のモデルと一致、既存のまま使える)。
- `panel_id` は FK ではなくアプリ側で `layout.panels` 実在検証。レイアウト変更時の `panel_id` NULL 化後始末は `dialogueLines.ts` に実装済み(`nullifyOrphanedPlacementPanelIds`)。
- 既存 API: `GET/POST /api/projects/:id/dialogue-lines`、`POST /api/dialogue-lines/:id/placements`(1件ずつ)、`PATCH/DELETE /api/dialogue-placements/:id`。一括 API は無い。
- `PageObject`(src/shared/pageObjects.ts): union(Text/Balloon/Box/Image)。`PageObjectBase.sourceDialogueLineId` が既にあり、`balloon_object_id` ⇄ `sourceDialogueLineId` の双方向リンク規約が存在する。一括生成でも必ず両方向を設定すること。
- `BalloonObject.tail: BalloonTail | null`(tip はローカル座標)。`defaultBalloonTail(size)` あり。
- `PAGE_OBJECTS_MAX_COUNT = 300`。API は超過を拒否しトースト表示が既存方針。
- 文字レイアウト: `computeTextLayoutForContent(content, maxWidth)`(src/server/textLayoutApi.ts、LRU 付き)で必要 bbox を事前計算できる。**自動バルーンサイズはこれを新規結線する**(S3 では将来課題とされていた箇所)。
- ページ編集 UI: `pagePanelLightboxController.ts` + `views/pagePanelLightboxView.ts`。モードタブ `panels|objects|shapes|mosaic`。セリフドロワー(`dialogueDrawerOpen` 等)は objects モードにある。
- レイアウト: `PageLayout`(src/shared/pageLayout.ts)。`readingDirection: "rtl"|"ltr"`、panels は polygon/rect/ellipse/path、座標系は width-relative-top-left(x∈[0,1])。`panelBounds` 等ヘルパあり。
- Undo/Redo: `src/client/pageObjectHistory.ts`(スナップショット2スタック、上限50)。
- クライアント規約: `registerActions()` / `registerEventBinder()`(actionRegistry)。**main.ts へ関数追加禁止**(composition root)。state は appState、更新は `requestRender()`。
- サーバー規約: index.ts の if 連鎖ルーティング(**ルート順序衝突に注意**)。ドメインロジックはモジュール分離。トランザクション前例は `reorderPages` の BEGIN/COMMIT。
- テスト: `bun test`、node:test + node:assert/strict、相対 import は `.ts` 拡張子明示。`GURUGURU_TEST_DB=1` で隔離。

## 1. 目的とフロー

```text
Fountain脚本 → Chronicle上の脚本区間(Beat) → 現在ページへ割り当て(placements, balloon_object_id=NULL)
→ ページ内コマへ仮配分 → 配置案プレビュー(DB非更新) → 確定(トランザクション一括保存) / 再配置(seed変更) / 手動修正(自動ロック)
```

操作単位はページ。配置ソルバーが内部的にコマ(reading direction 順)へ配分する。

## 2. 仕様

### 2.1 表示条件・位置

- Book プロジェクト、かつ MangaScript が1件以上、かつ有効な Script Revision がある場合のみ、ページ編集 lightbox 下部に折り畳み可能な固定バーとして表示。
- 新しい ProjectMode は作らない。
- 複数脚本はバー左端のセレクタで切替。
- lightboxを開いたページにplacementを持つ脚本があれば、その脚本を自動選択する。該当が無い場合だけ
  脚本一覧の先頭へフォールバックする。
- **注意: lightbox 直下に行を足す場合は `grid-template-rows` の更新必須**(過去に高さ0潰れの不具合あり。Docs/ 既知の罠参照)。
- 機能: 横スクロール(Shift+ホイール対応)、高さ変更、折り畳み状態の記憶(クライアント側 localStorage で可)、現在ページの割り当て範囲強調、ページ切替時の自動スクロール、「次の未配置区間へ」ボタン。
- 現在ページのBeatが1件以上ある時だけ、該当Beatを`aria-current`・不透明度1で強調し、それ以外を
  不透明度0.42へ減光する。自動スクロール完了は対象DOMが実在した時だけ記録し、非同期描画前の空振りで
  再試行を失わない。

### 2.2 ChronicleBeat

すべての行を点で並べず「会話のまとまり」を Beat として表示する。純ロジック(src/shared/chronicleBeat.ts)で決定的に構築:

- 同一シーン内の連続した発話(dialogue/monologue)をまとめる
- narration / sfx / scene 境界 / semantic_kind の切替で分割
- 一定の文字数(目安 120 字)または発話数(目安 6)超で分割
- 将来: LLM による演出的 Beat 分割(MVP 外)

```ts
interface ChronicleBeat {
  id: string;            // 決定的に生成(revisionId + 先頭lineId 等から)
  sceneIndex: number;
  lineIds: string[];
  label: string;         // 話者名など
  summary: string;       // 先頭セリフの抜粋
  speakerIds: string[];
  startOrder: number;    // order_index
  endOrder: number;
}
```

Beat の状態(色分け)は lines/placements から集約して導出する(保存しない):

| 状態 | 導出 |
|---|---|
| unassigned | placement が無い行を含む |
| assigned | 全行 placement 有り・balloon_object_id=NULL |
| materialized | 全行 balloon_object_id 有り |
| otherPage | 現在ページ以外へ配置済みの行を含む |
| orphaned | dialogue_lines.status が orphan の行を含む |
| locked | auto_layout_locked=1 の placement を含む(補助表示) |

(元計画の Stale=文言差分表示は既存の orphan/再取り込み管理に委ね、MVP では独立状態にしない)

### 2.3 基本操作

- **Beat クリック**: 内容プレビュー(セリフ・話者・配置先ページ)。ページ内に対応吹き出しがあれば選択。
- **範囲ドラッグ選択**: 複数 Beat 選択。文字数・発話数・推定吹き出し数を表示。
- **現在ページへ割り当て**: 選択範囲の行を bulk API で placement 化(balloon_object_id=NULL)。
- **配置案**: 割り当て済み・未吹き出し化の行から preview API でプレビュー(DB 非更新、クライアントはゴースト描画)。
- **確定**: apply API で PageObject 一括生成+placements 更新(トランザクション、失敗時全件ロールバック)。
- **再配置**: seed を変えて preview→apply をやり直す。ロック済みは動かさない。
- **割り当て解除**: 選択 Beat の placement を削除(balloon 化済みは対象外か確認ダイアログ)。
- **Undo**: 一括確定を pageObjectHistory の1エントリとして戻せる。

### 2.4 DB 拡張

`ensureColumn` パターンで `dialogue_placements` に追加:

```sql
auto_layout_locked INTEGER NOT NULL DEFAULT 0  -- 1=手動編集済み、再配置対象外
auto_layout_seed INTEGER                        -- 配置再現用 seed
auto_layout_version INTEGER                     -- 配置アルゴリズムのバージョン
```

### 2.5 自動配置アルゴリズム(src/shared/dialogueAutoLayout.ts、純ロジック)

入力: ページの `PageLayout`、既存 `PageObject[]`(障害物)、配置対象の行(テキスト・semantic_kind・話者)、各行の必要サイズ(サーバーで `computeTextLayoutForContent` から算出して渡す)、seed。

ハード制約:
- 吹き出し同士・ロック済み/既存オブジェクトと重ねない
- ページ外へ出さない。通常の会話吹き出しはコマ bounding box 内(+最低余白)
- narration/sfx/字幕系はページ全体候補も許可
- `PAGE_OBJECTS_MAX_COUNT` 超過なら配置不能として扱う
- 同一行への PageObject 重複作成をしない
- コマ順(reading direction)と発話順(order_index)を逆転させない

ソフト制約(スコア): コマ上部優先、RTL は右上→左下 / LTR は左上→右下、コマ中央を覆わない、既存画像回避、余白均等、同一話者近接、過大サイズ回避。

seed 付き決定的探索: 同 seed → 同配置(単体テストで再現可能)。「再配置」は seed 更新。乱数は自前の単純 PRNG(mulberry32 等)で `Math.random` は使わない。

Polygon コマは bounding box で候補生成後、内部判定(既存ヘルパ流用)で絞る。

サイズ超過時は縮小して押し込まず、警告として「分割/次ページ送り/フォント縮小/範囲縮小/手動」を提示(MVP では警告文言のみで自動対処しない)。

尻尾: MVP では `defaultBalloonTail` の既定方向。話者位置追従は MVP 外。

### 2.6 手動編集との関係

自動生成された吹き出し(placement に auto_layout_seed がある)をユーザーが移動/リサイズ/回転/尻尾変更したら、対応 placement の `auto_layout_locked=1` を自動設定。再配置から除外。個別・一括解除 UI を用意。

### 2.7 Fountain 再取り込み

既存の `dialogue_lines.source_hash` / status 管理に乗る。同一行は割り当て・吹き出し維持、削除行は Chronicle 上 orphaned 表示(吹き出しは自動削除しない)、新規行は未配置として追加、並び順変更は Chronicle 表示のみ更新。ここは既存挙動の確認+表示が主で、新ロジックは最小。

## 3. API

```
GET  /api/projects/:projectId/chronicle?scriptId=...
     → { scriptId, revisionId, beats: ChronicleBeat[], lines: 状態導出用の行+placement要約,
         pages: [{pageId, pageIndex, lineIds}] }

POST /api/projects/:projectId/pages/:pageId/dialogue-allocation
     body: { lineIds: string[], existingPlacementPolicy: "skip"|"move"|"copy" }  // 既定 skip
     冪等(既に当該ページへ配置済みの行はスキップ)。BEGIN/COMMIT。

POST /api/projects/:projectId/pages/:pageId/dialogue-layout/preview
     body: { placementIds: string[], seed: number, respectLocks: true }
     → { seed, objects: PageObject[], assignments: [{placementId, panelId|null, objectId}],
         warnings: string[], unplacedPlacementIds: string[] }
     DB 非更新。

POST /api/projects/:projectId/pages/:pageId/dialogue-layout/apply
     body: { placementIds: string[], seed: number }
     トランザクション: PageObject 生成 → objects_json 更新 → balloon_object_id / panel_id /
     auto_layout_seed / auto_layout_version 設定。1件でも配置不能なら 409/422 で全件ロールバック
     (部分確定しない)。楽観ロックは無し(将来課題)。
```

ルート登録は index.ts の dialogue 系ブロック(L608 付近)へ。`/pages/:pageId/...` 系の既存ルートとの順序衝突に注意。

整合性ルール: ページの objects 保存時(既存 save 経路)に、`balloon_object_id` が objects_json に存在しない placement は `balloon_object_id=NULL` へ戻す(assigned 状態へ復帰)。これにより Undo/手動削除後も参照が浮かない。既存に同等処理があるか確認し、無ければ実装する。

## 4. モジュール構成

```
src/shared/chronicle.ts          … API 型・Beat 型・状態型・Preview 型
src/shared/chronicleBeat.ts      … Beat 構築・状態集約(純ロジック・テスト対象)
src/shared/dialogueAutoLayout.ts … 候補生成・重なり/内部判定・スコア・seed 選択(純ロジック・テスト対象)
src/server/chronicle.ts          … Chronicle 取得・一括割り当て
src/server/dialogueAutoLayoutApi.ts … preview/apply、サイズ計算結線、トランザクション
src/client/chronicleController.ts   … registerActions/registerEventBinder、スクロール、範囲選択、API 呼び出し、ページ移動後の非同期ガード
src/client/views/chronicleBarView.ts … バー描画・状態色・プレビュー UI
src/client/styles/chronicle-bar.css  … スタイル(既存 css の読み込み方法に従う)
```

appState へ追加:

```ts
interface ChronicleUiState {
  status: "idle" | "loading" | "ready" | "error";
  collapsed: boolean;
  scriptId: string | null;
  revisionId: string | null;
  beats: ChronicleBeat[];
  selectedBeatIds: string[];
  preview: DialogueLayoutPreview | null;
  busyAction: null | "assign" | "preview" | "apply" | "reflow";
}
```

main.ts へは composition root としての初期化呼び出しのみ(関数追加禁止)。

## 5. MVP に含めないもの

LLM 自動ページ分割 / 画像解析・顔検出・話者位置推定・尻尾追従 / 重要被写体回避 / 自動画像生成 / 複数脚本混在配置 / 見開き最適化 / LLM Beat 分割 / 楽観ロック / Stale(文言差分)状態表示。

## 6. 実装フェーズ(各フェーズ: worktree で実装 → bun test 全緑 → main へマージ)

### フェーズI: Chronicle 表示
共有型、Beat 構築、GET /chronicle、バー表示(横スクロール・折り畳み・状態色・Beat プレビュー・ページ範囲強調)。
受け入れ: 脚本なしプロジェクトで非表示 / 取り込み済み Book で表示 / セリフ順一致 / ページ切替で壊れない / 1680×920・1600×900 で編集領域を妨げない / 折り畳み可 / lightbox の grid-template-rows 潰れなし。

### フェーズII: ページ割り当て
範囲選択、dialogue-allocation API(冪等・policy 3種)、割り当て解除、ページ別色分け、「次の未配置区間」移動、他ページ配置の警告。
受け入れ: 一括割り当て可 / 繰り返しても重複しない / 既定で他ページ配置を動かさない / 再取り込み後も一致行の割り当て維持 / ページ削除時に placement が残らない(既存 cascade 確認)。

### フェーズIII: 吹き出し一括配置
サイズ計算結線、コマ順配分、候補探索、preview/apply API、ゴーストプレビュー、確定、全件ロールバック、DB 3列追加。
受け入れ: 非重複 / コマ・ページ外に出ない / 同 seed 同配置 / 全件配置不能なら部分確定しない+理由警告 / 既存吹き出し不変 / PNG・ORA 書き出しへ反映 / sourceDialogueLineId と balloon_object_id の双方向リンク設定。

### フェーズIV: 再配置とロック
seed 更新再配置、手動編集での自動ロック、ロック除外、個別・一括解除、一括 Undo(1履歴エントリ)、Chronicle⇄吹き出しの相互選択ジャンプ。
受け入れ: ロック済みが動かない / Undo 1回で一括配置前へ / 相互選択同期 / 解除後は再配置対象へ復帰。

### フェーズV: 仕上げ
再取り込み・orphan 表示、objects 保存時の balloon_object_id 整合(§3 整合性ルール)、ページ/コマ削除・レイアウト変更・最大オブジェクト数・RTL/LTR・書き出し・エラーロールバック・ページ移動中の非同期ガードの総点検、Docs 更新(本書を Done へ移動、操作メモ.md へ日常注意を追記)。

## 7. テスト

- 単体(bun test): Beat 分割 / 行順序 / RTL・LTR コマ順 / seed 再現 / 矩形・Polygon 内判定 / 非重複 / 既存回避 / 配置不能 / ロック除外 / 上限 / サイズ計算。
- API: 割り当て冪等 / policy skip・move・copy / preview 非破壊 / apply トランザクション / orphan / ページ削除 cascade / 失敗 rollback。
- UI(必要ならヘッドレス API 検証+preview ツール目視): 表示条件 / 折り畳み / 範囲選択 / ページ切替 / preview / apply / 再配置 / Undo / 相互選択 / 1680×920・1600×900。
- 検証は必ず `GURUGURU_TEST_DB=1`(+隔離 `GURUGURU_TEST_DATA_DIR`)、ポートは 5178 等。本番データ・本番 ComfyUI(8188)を使わない。

## 8. 将来課題(記録)

- expectedPageUpdatedAt による楽観ロック(複数クライアント同時編集時)
- LLM ページ分割・Beat 分割、話者位置推定と尻尾追従、GenerationIntent 自動構築(元計画 §2.11, §2.14, §9 順序6〜8)
- サイズ超過時の自動分割・次ページ送り

## 9. 実装結果(2026-07-11、フェーズI〜V 完了・main マージ済み)

各フェーズの main マージコミット:

| フェーズ | Feature commit | Merge commit |
|---|---|---|
| I(Chronicle 表示) | `ee915f9` | `8dea8eb` |
| II(ページ割り当て) | `8489bd6` | `cd056fd` |
| III(吹き出し一括配置) | `54c111e` | `b87449e` |
| III 品質修正(SFXページ全体フォールバック+サイズバリアント+中点配分) | `3bf898f` | `6f2598f` |
| IV(再配置とロック) | `7b68a41` | `2020cdc` |
| V(仕上げ) | 本コミット | 本コミット |

### 実装上の主要判断(フェーズV)

- **reflow の担当コマ固定緩和**: ソルバー(`runDialogueAutoLayout`)は元々「担当コマに空きが無ければ即
  unplaced」だった。2×2 グリッドでロック済み吹き出しが担当コマを占有していると、乱数はスコア同点の
  tie-break にしか使われないため seed を変えても解消しない(全滅)構造的な問題があった。発話順とコマ順の
  単調性(order_index 昇順で panelId のコマ順が逆転しない)を壊さない範囲(直前に panel ベースで配置した
  発話のコマ index の次〜担当 index+2)で後続コマへフォールバックするよう修正した。sfx の既存ページ全体
  フォールバックとは独立に動作する(sfx は対象外、従来どおり)。詳細は
  [`Docs/Reference-DialogueAutoLayout.md`](Reference-DialogueAutoLayout.md) §6。
- **オブジェクト id 衝突の修正**: `nextObjectId` は seed をまたいだグローバルカウンタを持たない設計のため、
  reflow を同じ seed で複数回叩く等で `existingObjects`(ロック済みオブジェクト含む)の id と衝突しうることが
  判明した(`normalizePageObjects` の `_dup` リネームに巻き込まれ、ロック済みオブジェクトの id が変わって
  `balloon_object_id` 参照が浮く)。ソルバー内で使用済み id 集合を追跡し、衝突する id を避けて `localIndex` を
  進める形で修正(決定性は維持)。詳細は [`Docs/Reference-DialogueAutoLayout.md`](Reference-DialogueAutoLayout.md) §7。
- **Fountain 再取り込み・整合性ルール(§2.7・§3)は S3〜S4 の既存実装のまま**で要件を満たしていることを
  フェーズVで確認した(新規ロジックはほぼ不要だった、設計書の想定どおり)。`getChronicle` は常に最新
  revision を参照し(`resolveLatestRevision`)、orphaned 行も Chronicle 上に残る。`updatePageObjects` は
  objects_json 保存時に浮いた `balloon_object_id` を自動で NULL 化する(`reconcileOrphanedPlacementBalloonIds`)。
- **ページ削除時の dialogue_placements cascade**は `dialogue_placements.page_id` の
  `FOREIGN KEY ... ON DELETE CASCADE`(`db.ts`)+ `PRAGMA foreign_keys = ON` で DB レベルに任せている
  (アプリコードで明示的な削除は不要)。フェーズVで動作確認済み
  (`src/server/dialogueAllocation.test.ts` 「ページ削除時に dialogue_placements が残らない(FK CASCADE)」)。
- **PNG/ORA 書き出し**は `openRasterExport.ts` の `renderPageObjectElement` が box(P1)/text(P2)/balloon(P3、
  thought 含む)を既に描画しており、画像一括書き出し(`imageExport.ts`)も同じ `createPageLayers`/
  `renderMergedImage` を再利用するため、一括配置由来のオブジェクトも自動的に反映される。フェーズVで
  「実際に非透明ピクセルとして描画される」ことまで確認する回帰テストを追加した
  (`src/server/openRasterExport.test.ts`)。
- **非同期完了ガード(ページ移動中)**: `chronicleController.ts` の全 API 呼び出し(load/assign/preview/apply/
  reflow/unlock)は `await` 直後に必ず `state.pagePanelLightbox?.pageId !== context.pageId` を確認しており、
  ページ切替/lightbox クローズ後に応答が着弾しても state を書き換えない。フェーズVのコードレビューで
  既存実装が要件を満たしていることを確認した(修正不要)。
- **1680×920 / 1600×900 での編集領域確保**: `.page-panel-dialog` の `grid-template-rows` は
  `auto auto minmax(0, 1fr) auto auto` の5行(ヘッダー/タブ/ステージ/ツールバー/Chronicle バー)で、
  ステージ行のみ `minmax(0, 1fr)` で可変、Chronicle バーは `max-height: 128px`(折り畳み時はヘッダーのみ)。
  ダイアログ全体は `max-height: calc(100vh - 48px)` に収まるため、1600×900 でもステージが 0 に潰れることは
  ない(CSS レビューで確認。ブラウザでの実測未実施 -- 環境上ブラウザ確認ツールは利用可能だが本タスクでは
  CSS の根拠確認に留めた)。

### 既知の制限(設計書§8のとおり、フェーズVでも変更なし)

- 楽観ロック(expectedPageUpdatedAt)は未実装。lightbox を開いている本人だけが操作する前提(last-write-wins)。
- LLM ページ分割・Beat 分割、話者位置推定と尻尾追従は MVP 外のまま。
- サイズ超過時の自動分割・次ページ送りは警告文言のみ(自動対処なし)。
- 後続コマへのフォールバック範囲は「担当 index+2」までの固定値。それ以上離れたコマへは逃がさない
  (行きすぎた再配置による読み順崩壊を避けるための意図的な制限)。

## 変更履歴

- 2026-07-14: 現在ページにplacementを持つ脚本の自動選択、現在Beat以外の減光、描画後の確実な
  自動スクロールを追加。1680×920で配置済みBeat=opacity 1、未配置Beat=0.42、console error 0を確認。
- 2026-07-11: フェーズI〜V 完了。§9 に実装結果(merge commit・主要判断・既知の制限)を追記し、
  `Docs/Done/` へ移動。
- 2026-07-11: 初版。元計画を既存コード調査と決定事項(ドロワー併存・楽観ロック省略・I〜V 実施)で改訂。
