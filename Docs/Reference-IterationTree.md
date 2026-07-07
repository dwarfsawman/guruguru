# イテレーションツリー リファレンス

イテレーションツリー(ラウンド履歴グラフ)の表示挙動に関する内部実装メモ。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## Workflow diagram

- WorkflowTemplate 一覧の `diagram` ボタンは、保存済みの ComfyUI API形式 workflow JSON から Mermaid の簡略図を表示する。
- テンプレート登録は通常時ボタンだけを表示し、押すとモーダルで API形式 workflow JSON、role map、Mermaid プレビューを確認して登録する。
- Mermaid プレビューは workflow JSON の `inputs` にある `[node_id, output_index]` 形式の接続をエッジとして扱う。role map で参照されるノードは図上で強調表示する。

## Round ドットの状態表示

- ノードのドット class は Round の status から決める(`iterationTree.ts`)。終端状態の `interrupted` / `failed` は `pending` のパルス点滅を引き継がない**専用 class** にする(停止後・失敗後に点滅し続けないため)。`completed` / `active` / 実行中の `running` はそれぞれ独立の class。

## エッジポップアウト

- 親→子エッジの hover/focus ポップアウトは、生成時のプロンプト・解像度・デノイズ・step などを表示する。ポップアウトは `position: fixed` + CSS anchor positioning で、`.iteration-tracker` のスクロール領域にクリップされない。
- 添付があるエッジでは、フッタ「添付 n件」をクリックまたはポップアウト上で下方向ホイールすると展開する。展開後は貼り付け画像、マスク形状、ポーズ画像を別アイテムとして表示し、クリックしたアイテムを上部の拡大プレビューに出す。
- 添付のデータ源は `round.request`: 貼り付けは `pasteComposite.objects[].sourceId` から `/api/projects/:projectId/paste-sources/:sourceId`、マスクは `inpaint.maskPath` から `/api/rounds/:roundId/attachments/mask`、ポーズは `controlnet.poseImagePath` から `/api/rounds/:roundId/attachments/pose` を参照する。
- `.iteration-edge` は通常時もエッジの当たり判定として `z-index` を持つ。ポップアウト表示中は `.iteration-tracker` と対象エッジをさらに持ち上げ、グリッドカードのバッジ・seed・カード番号の背面に回らないようにする。

## イテレーションツリーのスクロール保持

- イテレーションツリー(`.iteration-tracker`)は `render()` で `app.innerHTML` ごと再生成されるため、DOM 再生成前後で `scrollLeft` / `scrollTop` を保存・復元する必要がある。
- `render()` はデフォルトでスクロール位置を保存・復元する。Round 選択(`selectRound`)や画像詳細オープン(`openAssetDetail`)でも `render()` をそのまま使い、スクロール保持を有効にする。
- `render({ preserveIterationScroll: false })` はスクロールを意図的にリセットしたい場合だけ使う。
- プロジェクト切替(`openProject`)や Home 戻り(`loadHome`)では、別プロジェクトの古いスクロール位置を引き継がないよう `state.iterationScroll = null` を明示的にリセットする。
- `scrollIntoView()` で active ノードに寄せる修正は、ユーザーの手動スクロール位置を維持する要件と逆になるため入れない。
