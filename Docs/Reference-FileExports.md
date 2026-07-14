# File Export Reference

PNG/JPEG ZIP、PPTX、OpenRaster のサーバー側パッケージングとHTTP配信の現在仕様です。

## 成果物のライフサイクル

- `withImageExport` / `withOpenRasterExport` / `withScriptMangaRunExport` は、OS一時ディレクトリに成果物を作り、callback完了まで保持する。
- HTTP経路は `streamFileExport` が `Content-Length` を付けて `createReadStream` から応答へ流す。完成ZIPやPPTX/ORAをBunの`Buffer`へ読み戻さない。
- callbackの成功・失敗を問わず、検証済みの`guruguru-file-export-*`一時ディレクトリだけを削除する。
- 単一PNG/JPEGも同じファイル契約を使う。複数画像だけ外側ZIPを作る。

## Rust pack

`native/guruzip-archive`の`pack`コマンドが、TypeScriptの作った小さなentries JSONを指定順に読み、ファイルからZIPへ逐次コピーする。

```text
guruzip-archive pack --archive output.zip --entries entries.json --buffer-bytes 10485760
```

entriesは`source`、`archivePath`、`compression`（`store` / `deflate`）を持つ。Rust側でZIP内パス、重複、通常ファイルかを検証し、4GiB以上のentryにはZIP64を使う。OOXMLや`stack.xml`の生成責務はTypeScript側に残す。

| entry | compression |
| --- | --- |
| PNG/JPEG | STORE |
| 外側ZIP内の`.ora` | STORE |
| XML/JSON/rels | DEFLATE |
| ORA `mimetype` | 先頭・STORE |

PPTXはページPNGを1枚ずつ一時ファイルへ書き、XML/relsを生成してRustでpackする。ORAはページ単位でlayer PNG、merged image、thumbnail、stack.xmlをpackし、複数ページ時だけ完成ORAを外側ZIPへSTOREする。

## 計測

各書き出しは`[export-metrics]` JSONログへ次を出す。

- `renderMs`、`zipMs`、`responseMs`
- `pageCount`、pack入力の生成バイト数、最終`outputBytes`
- 25ms間隔で観測したBunプロセスの`peakRssBytes`
- `kind`、`format`、`status`

Rust helper自身の固定コピーバッファは`GURUGURU_ARCHIVE_BUFFER_MIB`（既定10MiB）を使う。大規模比較は`benchmark:export`、WebSAM後処理は`benchmark:websam`で再計測する。
