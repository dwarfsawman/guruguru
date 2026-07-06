# 生成パイプライン リファレンス

バッチ生成のジョブ分解・進捗監視・停止に関する内部実装メモ。**このファイルは完了ログではなく、コードの現状に合わせて随時上書き更新するリファレンス**(変更履歴は持たない)。

## 逐次生成・停止

- 通常生成の `batchSize` は ComfyUI 内部の大きな1バッチではなく、GURUGURU 側で `batch_size=1` の `generation_jobs` に分解してキュー投入する。
- 各ジョブは同じ ComfyUI `client_id` を使い、サーバー側 WebSocket で `executed` / `execution_success` / `execution_interrupted` / `execution_error` を監視する。WebSocket通知を取り逃がした場合も、UIの自動 `collect` polling で回収する。
- UIの自動 `collect` polling は3秒間隔。サーバー側 WebSocket 監視が先に画像を取り込んだ場合も、`collect` 応答の round 集計数を見てUIを再読込する。
- 分割ジョブの seed は round に保存した先頭 seed を基準に、`batchIndex` ごとに `seed + batchIndex` を使う。asset の seed は各ジョブの実 seed。
- 停止ボタンは未実行・待機中 prompt を ComfyUI queue から削除し、実行中 prompt がこの round のものと判断できる場合は ComfyUI `/interrupt` を呼ぶ。保存済み asset はそのまま残り、停止後も選択や画像からのブランチングに使える。
- 複数アプリや別ユーザーが同じ ComfyUI を共有する運用では、`/interrupt` が現在実行中の ComfyUI ワークフローへ作用する点に注意する。
