# Examples

実機で確認した入力例と、その再現条件を置くディレクトリです。

| 例 | 内容 |
| --- | --- |
| [`ALICE_REBOOT_E01.fountain`](ALICE_REBOOT_E01.fountain) | Fountain 脚本入力例 |
| [`ALICE_REBOOT_E01-Reproduction.md`](ALICE_REBOOT_E01-Reproduction.md) | 上記脚本を85ページ・233コマの漫画へ変換した際の生成条件、再現手順、人間／Local LLM担当工程 |
| [`ALICE_REBOOT_E01-manga-plan.json`](ALICE_REBOOT_E01-manga-plan.json) | 実機生成で使用した承認済みMangaPlan V2。全85ページ・233コマの英語prompt、cast、台詞対応、レイアウトを収録 |

この例に限り、再現資料として承認済みMangaPlan JSONを収録しています。生成画像、キャラクター参照、workflow snapshot、DBなど、その他のランタイムデータはリポジトリへ置きません。再実行時はOSのユーザーデータ領域、またはリポジトリ外のテストデータディレクトリへ保存してください。
