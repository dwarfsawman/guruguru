# OpenRaster Export Reference

Book ページを OpenRaster (`.ora`) として書き出すサーバー機能の現在仕様です。

## 基本方針

- インポート・編集は既存の `PageLayout` (`guruguru-layout-template` 由来)を使う。
- エクスポートは `POST /api/projects/:projectId/openraster-export` で行う。
- `pageIds` 未指定なら Book 全体、指定ありならそのページだけを書き出す。
- 対象が1ページなら `.ora`、複数ページなら各ページ `.ora` を zip にまとめる。
- ORAと外側zipはOS一時ファイルへRust helperで逐次packし、HTTPへファイルストリーミングする。
- 見開きは「隣接2ページを結合」ではなく「横長キャンバスの1論理ページ」として扱う。作成フォームの `見開きB5横(364:257)` プリセットを使う。

## ORA 構成

- `mimetype` は先頭・無圧縮で `image/openraster`。
- `stack.xml` は OpenRaster の標準要素だけで構成する。
- `data/layer-*.png` に全レイヤ PNG を入れる。
- `mergedimage.png` と `Thumbnails/thumbnail.png` も生成する。
- PNGと外側zip内の`.ora`はSTORE、`stack.xml`だけDEFLATEする。
- OpenRaster の layer stack は先頭要素が最前面なので、`Panels` レイヤを `stack.xml` の先頭へ置く。
- 紙地は `Paper` レイヤとして最背面に入れる。Krita で開いたときに透明チェッカーではなくページ地が見える。

## レイヤ

- 通常ページは代表画像をキャンバスに contain して1 PNGレイヤにする。画像が無ければ透明レイヤ。
- コマ割りページは、割り当て済みコマごとに asset を crop 反映して透明PNGレイヤへ描画する。
- コマ枠は `Panels` という最前面 PNG レイヤとして出力する。
- `path` 形状は SVG transform で描画するため、複雑な path は OpenRaster 出力時もベストエフォート。

## 変更履歴

- 2026-07-09: `Paper` レイヤを最背面に追加し、Krita 読み込み時も紙地が見えるようにした。
- 2026-07-09: 初版。Book 全体/選択ページ/単体ページの OpenRaster export と見開き方針を記録。
