# Production Packet 取り込みリファレンス

上流の作品管理ツール（Character Garage 等）が書き出す **production packet** を、GURUGURU が検証つきで取り込むための現行仕様である。GURUGURU は相手の内部DB・内部保存形式を一切参照せず、この公開フォーマットだけに依存する。逆に上流も GURUGURU の `app.db` を知らない。

実装は [`src/server/productionPacket.ts`](../src/server/productionPacket.ts)、テストは同ディレクトリの `productionPacket.test.ts`。

## パケットの形

パケットはプレーンなディレクトリである。zip ではない。

```text
<packet dir>/
├─ packet.json                       マニフェスト
├─ script.fountain                   その話の Fountain 脚本（任意）
└─ assets/characters/<slug>/…        同梱された参照画像（任意）
```

`packet.json` の主なフィールド。

| フィールド | 意味 |
| --- | --- |
| `formatVersion` | 形式のバージョン。現行は `1`。異なる値は取り込まない |
| `kind` | 常に `"manga-production-packet"` |
| `generator` | 書き出したツールの `{ name, version }` |
| `source` | 上流での識別子 `{ workId, episodeId }`。再取り込みの同一性判定に使う |
| `work` / `episode` | 作品名・説明、話数・タイトル・概要 |
| `storyBible` | `logline` / `theme` / `premise` / `tone` / `ending` / `audience` / `notes` / `settings[]` |
| `cast[]` | `name` / `displayName` / `aliases[]` / `profile`（外見）/ `arc` / `outfits[]` / `referenceImages[]` |
| `relationships[]` | `{ from, to, kind, description, directed }`。名前で参照する |
| `outline` | `beats[]`（`name` / `summary` / `function` / `characters[]` / `setting`）と `pages[]`（`number` / `summary` / `beats[]` / `turnNote`） |
| `script` | `{ path, bytes, sha256 }` |
| `loras[]` | `{ character, name, bytes, bundled }`。`bundled` は形式1では常に `false` |

同梱ファイルはすべて `{ path, bytes, sha256 }` で宣言する。`path` は必ずパケット相対・スラッシュ区切りで、絶対パス・ドライブレター・`..` は拒否する。

## 検証（先に必ず通す）

`readPacket(dir)` は次を順に確認し、1つでも失敗すれば `HttpError 400` を投げる。取り込み側は検証を通ってからしか書き込まない（fail-closed）。

1. `packet.json` が存在し、JSON として読める
2. `kind` が一致する
3. `formatVersion` がこのビルドの対応版と一致する
4. `episode.number` が1以上の整数、`work.title` が非空、`source` が揃っている
5. `cast[].name` が非空で、大文字小文字を無視して重複しない
6. 宣言されたすべての同梱ファイルが実在し、長さと SHA-256 が一致する
7. すべての同梱パスがパケット外を指していない

## 取り込みが行うこと

`POST /api/production-packets/import` `{ packetPath, projectId?, projectName? }`

1. 上の検証を通す
2. `projectId` 未指定なら Book プロジェクトを新規作成する（`projectName` 未指定なら作品名＋話数から作る）
3. **キャストを先に登録する。** `name` で照合し、`aliases` には別名と `displayName` を入れ、`notes` には外見・アーク・衣装差分をこの順で書く
4. 脚本を取り込む。同じ `source` から作られた脚本が既にあれば新しい revision を足し、無ければ新規作成する
5. 参照画像をプロジェクト配下の `packet_assets/` へ複製する
6. `storyBible` / `relationships` / `outline` / アーク / `characterBible` / 参照画像の対応を `projects.story_context_json` へ保存する

### キャストを脚本より先に入れる理由

`createScript` は Fountain の話者表記から未知のキャラクターを自動作成する。脚本を先に取り込むと、パケットの正式名・別名・外見が付かないまま話者名だけのキャラクターが増え、後から入れたキャストと二重になる。順序はこの重複を避けるためのもので、入れ替えてはいけない。

### Reference Set を自動で作らない理由

Reference Set は model family（Chroma は face、Anima は face + full_body）と人の承認が絡む GURUGURU 側の判断であり、`appearancePromptEn` のような GURUGURU 固有の入力も要る。取り込みは画像をプロジェクト配下へ置くところまでに留め、どの画像をどの family の候補にするかは通常の Reference Set フローに任せる。

### LoRA を同梱しない理由

パケットを軽く保ち、モデルの配布を伴わないため。`loras[]` はファイル名・サイズ・所属キャラクターだけを記録する。取り込みは「同名の LoRA を ComfyUI 側に用意してから生成すること」を `warnings` で返す。

## characterBible

`buildCharacterBible()` は `cast[].profile` と衣装差分から、script-manga run の `characterBible` にそのまま渡せる文字列を組み立てる。アークは prompt ではなく演出判断の材料なので `characterBible` には入れず、`story_context_json` の `arcs` と各キャラクターの `notes` に置く。

```powershell
bun run agent:cli -- --base-url <actual-url> packet verify --packet-path <dir>
bun run agent:cli -- --base-url <actual-url> packet import --packet-path <dir> [--project-id <id>]
bun run agent:cli -- --base-url <actual-url> packet context --project-id <id>
```

`--packet-path` は **API サーバーから見えるパス** である（通常は同一マシン）。

## 取り込み後の流れ

取り込みは素材を揃えるところまでで、ネーム以降は既存の手順（[`Docs/Reference-ScriptMangaAgentWorkflow.md`](Reference-ScriptMangaAgentWorkflow.md)）に合流する。

1. `packet import` → `projectId` と `scriptId` を得る
2. `packet context` の `characterBible` を run 設定へ渡す
3. `candidate create` / `candidate preflight` でネーム候補を作る
4. 実キャストの Reference Set を作って承認する
5. run を承認して生成を開始する

## 変更履歴

- 2026-07-29: 形式1を追加。検証つき取り込み、`projects.story_context_json`、`packet verify|import|context` の agent CLI コマンド。
