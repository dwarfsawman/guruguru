# Feature: 人間ゲートのコマ割り修正(Name Gate Layout Edit)

ネームスタジオ(人間ゲート)で、候補ページのコマ割りジオメトリと吹き出し位置を人間がドラッグで
修正し、「このネームで生成」で検査(full preflight)を通してからエージェントの生成フローへ渡す機能。
2026-07-18 実装。

## 操作(スタジオのページ下「✎ コマ割りを修正」)

| 操作 | 挙動 |
| --- | --- |
| 辺をドラッグ | 辺の法線方向へ平行移動(ポインタ移動を法線へ射影) |
| ◆ 境界ハンドル | 共有辺(ガター境界)を法線方向へ移動。**両側の隣接コマが追随**し、ガター幅は保たれる |
| ⇔ ガターハンドル | コマ間の余白を対称に詰め/広げ(最小0)。ドラッグ中は対象辺が**半透明プレビュー** |
| ● 交差点ハンドル | 複数コマの角が集まるジャンクション(田の字の中央など)を検出し、接続する全コマの角を一括移動 |
| ＋ 辺中点マーカー | 頂点を追加して多角形化 |
| ○ 頂点 | ドラッグで移動、ダブルクリック/Delete相当で削除(最低3点) |
| 外周辺を余白帯へドラッグ | 線が**半透明プレビュー**になり、離すと裁ち切り(page外 `LAYOUT_PANEL_BLEED`=0.015)へスナップ |
| 楕円(台詞番号) | 吹き出し位置ヒントをドラッグ指定。materialize の自動配置がこの近傍を強く優先する |

編集は共有辺の検出含めすべて共有純ロジック [src/shared/nameLayoutEdit.ts](../src/shared/nameLayoutEdit.ts)
(クライアントの操作とサーバーの保存時検証で同一関数)。頂点操作は既存
[src/shared/panelShapeEdit.ts](../src/shared/panelShapeEdit.ts) を再利用する。

### Bookページ編集(コマ枠タブ)でも同じ操作が使える(2026-07-18 追補)

上記の幾何操作(辺ドラッグ・◆境界・⇔ガター・●交差点・裁ち切りスナップ+半透明プレビュー)は、
Bookのページ編集 lightbox「コマ枠」モードにも同じハンドル・同じ純ロジックで組み込まれている
([src/client/panelShapeController.ts](../src/client/panelShapeController.ts) /
[src/client/views/pagePanelLightboxView.ts](../src/client/views/pagePanelLightboxView.ts))。
こちらは候補レイヤーではなく従来どおりページの `layout_json` へ 1s debounce PATCH で直接保存される。
rect/ellipse コマは最初の幾何ドラッグで自動的に polygon 化される(「多角形に変換して編集」の自動版。
id/order/frame/role は保持)。従来の選択→頂点編集・分割・吹き出し等のオブジェクト編集(レイヤタブ)は
無変更。吹き出し位置「ヒント」はネーム候補専用で、ページ編集では実オブジェクトを直接動かす。

### 検証(保存前クライアント/保存時サーバー共通)

`validateEditedNameLayout(edited, base)`:
- コマ数・id・order・role(figure) 不変(コマの追加・削除は不可)
- 全コマ polygon 3点以上・有限値・最小面積
- ページ境界から `PANEL_BLEED_OVERSHOOT`(0.02) 超のはみ出し禁止
- **読み順不変**: `orderPanelsByReadingDirection` の id 列が基準レイアウトと一致すること
  (台詞の自動配置がコマ幾何順に依存するため、順序が入れ替わる編集は拒否)

## データモデル(候補のレイヤー構造)

基礎プラン(plan_json)は不変。人間の編集は候補の別カラムに版数つきで載る:

```
script_manga_plan_candidates
  layout_overrides_json   -- ページ別テンプレ選択(V5 D5、既存)
  custom_layouts_json     -- Record<pageIndex, 編集済みPageLayout>   ← 本機能
  balloon_hints_json      -- Record<pageIndex, Record<orderIndex, {x,y}>>  ← 本機能
  edit_version            -- 楽観ロック(全レイヤー共通で加算)
```

- 実効プラン = `applyCustomNameLayouts(applyLayoutOverrides(plan, overrides), customLayouts)`。
  `page.customLayout` は **in-memory 注釈**で plan_json へは保存しない
  (freeze 時は `stripCustomNameLayouts` で除去)。
- set-layout(テンプレフリップ)は同ページの custom layout / hints を**破棄**する(旧テンプレ基準のため)。
- 採用済み(adopting/adopted)は 409。外部importのupsertも全レイヤーをクリアする。

## API

```http
POST /api/script-manga-plan-candidates/:id/set-custom-layout
{ "pageIndex": 0, "expectedVersion": 3,
  "layout": { ...PageLayout... } | null,          // undefined=変更しない / null=削除
  "balloonHints": { "0": {"x":0.7,"y":1.1} } | null }
→ 200 { "version": 4, "candidate": {...} }        // versionずれ・採用中は409、検証NGは422
```

候補ビュー(一覧/単体/adopt応答)へ `customLayouts` / `balloonHints` が追加されている。

## 採用〜生成への伝搬(検査が編集済みジオメトリで走る仕組み)

1. `adoptablePlanCandidate` が実効プランへ `page.customLayout` を注釈し、`balloonHints` を返す。
2. 監督LLMはページを再構築するため、採用経路(`createScriptMangaRunInternal`)で監督後に
   `applyCustomNameLayouts` を**再適用**する。
3. `buildMangaPlanV2` が `page.customLayout ?? resolveLayoutTemplate(...)` を **layoutSnapshot へ固定**、
   吹き出しヒントは orderIndex→lineId 解決のうえ `MangaPageSpec.balloonCenterHints` へ固定。
4. 以後の preflight(候補preflight/adopt内蔵の full preflight)・materialize・successor 継承は
   すべて snapshot 基準なので、追加の分岐なしに編集済みジオメトリで検査・生成される。
5. materialize の台詞自動配置は `preferredCentersByLineId` として受け取り、ソルバー
   (`runDialogueAutoLayout` の `preferredCenter`)がヒント位置そのものを候補に加えつつ近傍を強く優先する
   (ハード制約=障害物・コマ内判定・専有率は従来どおり。ヒント無しの挙動はバイト同一)。

「このネームで生成」ボタン(旧「この案で生成」)は専用 adopt API を呼ぶ。同APIは同じ設定で
full preflight を必ず再実行し、失敗時は 422 `{error, preflight}` で採用しない(UIはissuesをtoast表示)。
通過すると prepare-only run が作られ、以降は既存のエージェント生成フロー
(Reference-ScriptMangaAgentWorkflow.md §0)へ進む。

## クライアント実装

- [src/client/views/nameLayoutEditView.ts](../src/client/views/nameLayoutEditView.ts) — 編集ステージSVG
  (scale(1000) g 規約、`data-nle-*` 属性)とツールバー
- [src/client/nameLayoutEditController.ts](../src/client/nameLayoutEditController.ts) — ポインタ操作
  (ドラッグ開始時スナップショットへ純関数を適用)・保存・リセット。main.ts の pointer/dblclick 委譲へ
  panelShapeController と同型で登録済み
- ドラフトは `state.nameLayoutEdit` に持ち、ポーリング再renderでは消えない(候補一覧の差し替えとは独立)

## 関連する基準値の変更(2026-07-18、同時実施)

- `maxDialoguesPerPanel` 既定 4 → **3**(`DEFAULT_MAX_DIALOGUES_PER_PANEL`、4起因のpreflight fail対策)
- `SCRIPT_MANGA_MIN_FONT_SIZE` 0.016 → **0.014**
- `SCRIPT_MANGA_MAX_BALLOON_COVERAGE` 0.45 → **0.35**(吹き出しがコマに占める割合を抑制)

## 残課題

- ガター幅を共有辺判定の上限(0.08)超まで広げると、その境界の◆/⇔ハンドルが消える(辺ドラッグでは戻せる)
- ガターハンドルのドラッグ方向は法線基準(境界の向きによっては直感と逆になる場合がある)
- 吹き出しヒントは page 座標のため、ヒント設定後にコマ割りを大きく動かすとヒントがコマ外になる
  ことがある(ソルバーはハード制約でコマ内へフォールバックするため生成は壊れない)
- undo/redo はスコープ外(「編集をやり直す」=保存済み状態への復帰のみ)
