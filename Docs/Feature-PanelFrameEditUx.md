# コマ枠編集UIの刷新(hover-reveal + モードトグル)

2026-07-19 実装。ページ編集 lightbox「コマ枠」モードの操作系を、UI比較モック
(guruguru-mock/komawari-edit-mock の A案「ダイレクト仕切り」+ 最終モックzip + C案のガターグリップ)の
評価結果を基に刷新した。

## 採用した設計(モック評価より)

- **静かなキャンバス(モックzip)**: 既定表示は「紙 + コマの薄い塗り + 枠線 + コマ番号バッジ」だけ。
  ◆/⇔/●/＋ の常時表示ハンドルは全廃した。
- **hover-reveal(A案)**: 操作対象へマウスを寄せた時だけハンドルが現れる。
  - 共有境界(仕切り): 太い透明バンドが常時ヒット領域。hover で中心線(金色)と両側の
    ガターシェブロン〈 〉が現れる。バンドをそのままドラッグ=仕切り移動(両側追随)。
  - 非共有辺(外周など): hover でハイライト線。ドラッグで法線方向へ移動。
    余白の外へドラッグ→裁ち切りスナップは従来どおり(モックで操作できなかった「端のエッジ」も操作可能)。
  - 交差点: hover でドットが現れ、ドラッグで接続する全コマの角を一括移動。
- **ガターシェブロン(C案の変形)**: C案の中央グリップ(移動)は A案の「線を直接掴む」で代替できるため
  省略し、両側の〈 〉だけを採用。**外向きへドラッグで余白を広げ、内向きで詰める**
  (`data-gutter-dir=±1` で法線方向の符号を吸収)。
- **コマ番号バッジ = 移動ハンドル**: コマ中央の番号(読み順)をドラッグするとコマ全体が平行移動する。
  クリックだけなら従来どおりコマ選択(頂点編集)。移動 delta はコマ外接矩形から事前クランプするので
  ページ端で形が歪まない(bezier コマはアンカー+制御点ごと平行移動)。
- **モードトグル(A案)**: 「＋ 頂点追加」「⧉ コマ分割」「✎ 曲線枠を描く」は排他のモードに変更。
  - 頂点追加: 全 polygon コマの辺中点に＋マーカーを表示、クリックで追加(連続追加可)。
    従来の「選択コマの辺中点マーカー常時表示」は廃止。
  - コマ分割: **コマの選択が不要になった**。引いた線の中点を含むコマ(なければ分割が成立する最初の
    コマ)を分割する。分割後もモード継続(連続分割可)。
  - Esc で段階的に解除: モード/範囲選択 → コマ選択 → lightbox クローズ。

## 実装メモ

- ビュー: `src/client/views/pagePanelLightboxView.ts`
  `renderShapesStageContent` / `renderShapeGeometryHandles`(hover-reveal グループ)/
  `renderShapeOrderBadges` / `renderAddVertexMarkers` / `renderShapesToolbar`。
  hover は CSS(`.page-shape-boundary-group:hover .…`)、ドラッグ中の表示維持は
  `state.shapeActiveGeometry`(`is-active` クラス)で行う。
- コントローラ: `src/client/panelShapeController.ts`
  - 新規 state: `shapeAddVertexMode` / `shapeActiveGeometry`(appState.ts)。
  - 新規 action: `toggle-panel-shape-add-vertex-mode`。
  - `panelMoveDrag`(バッジドラッグ)、gutter drag の `dir` 係数、split の対象コマ自動決定
    (`pointInPolygon` を dialogueAutoLayout.ts から export)。
- キーイベント順: main.ts で `handlePanelShapeKeydown` を lightbox の Escape(閉じる)より先に呼ぶ
  よう変更(従来はフリーハンド等の Esc 解除が lightbox クローズに食われて到達不能だった)。
- 共有境界に属する辺の単独ドラッグは境界バンドに置き換えた(片側だけの調整は頂点ドラッグで可能)。
- バグ修正(従来から): `commitSplit` の order 再採番が draft と共有するパネルオブジェクトを直接
  書き換えており、直後に積む undo スナップショットへ分割後 order が混入していた
  (undo 後に order が 1,3,4,5 になる)。コピーへの再採番に変更。

## 検証(2026-07-19、worktree devサーバー + 合成PointerEvent)

仕切りドラッグ(+30px正確に移動・両側追随)、シェブロン両方向(外+10px→余白+20px、内8px→-16px)、
バッジ移動(dx/dy正確・歪みなし)、頂点追加(16マーカー→クリックで+1)、分割(選択なしで4→5コマ、
モード継続)、交差点/辺ドラッグ、undo/redo、Esc段階解除、分割undo後の order 保持(1,2,3,4)を確認。
`bun run test` 1148件緑。
