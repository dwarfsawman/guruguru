# イテレーションツリー リファレンス

イテレーションツリー(ラウンド履歴グラフ)の表示挙動に関する内部実装メモ。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## Workflow diagram

- WorkflowTemplate 一覧の `diagram` ボタンは、保存済みの ComfyUI API形式 workflow JSON から Mermaid の簡略図を表示する。
- テンプレート登録は通常時ボタンだけを表示し、押すとモーダルで API形式 workflow JSON、role map、Mermaid プレビューを確認して登録する。
- Mermaid プレビューは workflow JSON の `inputs` にある `[node_id, output_index]` 形式の接続をエッジとして扱う。role map で参照されるノードは図上で強調表示する。

## イテレーションツリーのスクロール保持

- イテレーションツリー(`.iteration-tracker`)は `render()` で `app.innerHTML` ごと再生成されるため、DOM 再生成前後で `scrollLeft` / `scrollTop` を保存・復元する必要がある。
- `render()` はデフォルトでスクロール位置を保存・復元する。Round 選択(`selectRound`)や画像詳細オープン(`openAssetDetail`)でも `render()` をそのまま使い、スクロール保持を有効にする。
- `render({ preserveIterationScroll: false })` はスクロールを意図的にリセットしたい場合だけ使う。
- プロジェクト切替(`openProject`)や Home 戻り(`loadHome`)では、別プロジェクトの古いスクロール位置を引き継がないよう `state.iterationScroll = null` を明示的にリセットする。
- `scrollIntoView()` で active ノードに寄せる修正は、ユーザーの手動スクロール位置を維持する要件と逆になるため入れない。
