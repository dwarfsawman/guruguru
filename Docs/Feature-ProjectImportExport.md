# Feature: プロジェクトのインポート / エクスポート(.gguru)

Status: Implemented v1(2026-07-12 規格策定、2026-07-14 性能更新)
Owner: Claude(監督)/ 実装: Sonnet 5 サブエージェント

## 目的

プロジェクト1件を単一ファイルにエクスポートし、同一または別の GURUGURU インスタンスへ
インポート(=複製)できるようにする。バックアップ・マシン間移動・プロジェクトの複製が用途。

## 1. コンテナ形式

- **拡張子: `.gguru`**(実体は標準 ZIP。JSZip で生成/読込。既存の ORA/PPTX と同じ機構)
- MIME: `application/zip`(ダウンロード時は `Content-Disposition: attachment; filename="<safeAsciiName>.gguru"`)
- ZIP 内構造:

```
manifest.json            … フォーマット識別・バージョン・概要
data.json                … DB 行のダンプ(下記スキーマ)
files/<relative-path>    … プロジェクトストレージ一式(projects/<id>/ 以下の全ファイル)
```

- `files/` 以下のパスは **projectRoot からの相対パス・区切りは `/` 固定**。
  例: `files/assets/original/round_xxx_000_img.png`
- `manifest.json` / `data.json` と既知のテキスト拡張子はDEFLATE、画像等のバイナリはSTORE(無圧縮)で格納する。
  標準ZIPのエントリ単位の混在圧縮なので`formatVersion`は1のまま。旧版の全DEFLATE `.gguru`も引き続き読める。

### manifest.json

```jsonc
{
  "app": "guruguru",
  "kind": "project-export",
  "formatVersion": 1,          // 整数。読み手は自分の対応値より大きければ拒否
  "exportedAt": "2026-07-12T…Z",
  "sourceProjectId": "project_…",
  "projectName": "…",
  "projectMode": "book",
  "counts": { "pages": 12, "rounds": 34, "assets": 120, "files": 250 },
  "warnings": ["…"]            // 例: projectRoot 外を指す絶対パスを検出した等
}
```

### data.json

```jsonc
{
  "project": { /* projects 行(スネークケースのまま=DB 列名そのまま) */ },
  "tables": {
    "pages": [...], "generation_rounds": [...], "generation_jobs": [...],
    "assets": [...], "asset_parents": [...], "selection_events": [...],
    "paste_sources": [...], "asset_paste_attachments": [...],
    "page_panel_assignments": [...], "page_media": [...],
    "characters": [...], "character_bindings": [...],
    "manga_scripts": [...], "script_revisions": [...],
    "dialogue_lines": [...], "dialogue_placements": [...], "dialogue_proposals": [...],
    "script_manga_plans": [...], "script_manga_runs": [...],
    "script_manga_run_pages": [...], "script_manga_tasks": [...]
  },
  "shared": {
    "workflow_templates": [...],   // 本プロジェクトから参照されるもののみ
    "layout_templates": [...],     // script_manga_run_pages.layout_template_id から参照されるもののみ
    "generation_presets": [...]    // rounds.preset_id / asset_parents.preset_id から参照されるもののみ
  }
}
```

- 行は **DB 列名(snake_case)のまま**格納する(`toApiRow` を通さない)。インポート側の
  INSERT がそのまま書ける・列追加に強い。
- JSON 列(`request_json` 等)は**文字列のまま**でよい(ただし §2 のパス書き換えを適用)。

## 2. パスのポータビリティ

DB には絶対パス(`image_path`、`binding_json` 内 `faceImagePath`、`request_json` 内の
mask/control/reference パス等)が格納されている。エクスポート時に以下の変換を行う:

- 各行の**全カラム値と、JSON 列は parse して再帰的に全文字列リーフ**を走査する。
- 文字列が旧 projectRoot 配下の絶対パス(`isPathInsideOrEqual` で判定。`/`・`\` 双方を
  正規化して比較)なら、`gguru://project/<projectRootからの相対パス(区切り/)>` に置換。
- `projects.storage_dir` はエクスポートでは `gguru://project/` とし、インポートで新パスに設定。
- dataRoot 配下だが projectRoot 外を指す絶対パスを見つけた場合: そのまま残し、
  manifest.warnings に記録(v1 では追跡コピーしない)。
- インポート時は逆変換: `gguru://project/xxx` → `join(newProjectRoot, xxx)`(OS の区切りに戻す)。

## 3. ID の扱い

- **プロジェクトスコープの行(§1 tables + project)は全て新 ID を採番**(`createId(prefix)`)。
  同一 DB への再インポート=複製、を自然に成立させるため。
- 旧ID→新ID のマップを作り、(1) 各行の ID/FK カラム、(2) JSON 列を parse した際の
  **文字列リーフが旧IDと完全一致する場合**に置換する(部分文字列置換はしない)。
  - UUID ベースの ID なので完全一致置換で衝突しない。
  - ファイル名に旧 round id 等が含まれる(`<roundId>_000_….png`)が、ファイルは**リネームせず**
    そのままコピーし、パス文字列も §2 の相対化のみ行う(=旧IDがファイル名に残るのは仕様)。
  - `balloon_object_id` / layout の `panel_id` 等、DB 行 ID でない JSON 内部 ID は変更しない。
- **shared(workflow_templates / layout_templates / generation_presets)は元 ID を保持**:
  - インポート先に同 ID が存在 → 既存行を再利用(上書きしない。内容差異は許容し警告不要)。
  - 存在しない → エクスポートされた行をそのまま INSERT(`deleted_at` も保持)。

## 4. ステータスの正規化(インポート時)

生成が進行中のまま export された行はインポート先で監視ループが動いてしまうため:

- `generation_rounds.status` が `pending`/`running` → `failed` に変更し、
  `last_error_json` に `{ "message": "imported while in progress" }` を設定。
- `generation_jobs.status` も同様に非終端値 → `failed`。
- `script_manga_runs.status` が非終端(`preparing`/`running` 等)→ `failed`。
  `script_manga_tasks` の非終端 status → `failed`。

## 5. API

- `GET /api/projects/:id/export` → `.gguru` バイト列を attachment で返す
  (既存の imageExport / openRasterExport のレスポンス形式に合わせる)。
- `POST /api/projects/import` → リクエストボディ = `.gguru` バイナリそのもの
  (`Content-Type: application/zip` 等は不問。multipart にはしない)。
  応答: `{ project: <新 projects 行(toApiRow)>, warnings: string[] }`。

### インポートの安全性(必須)

- **Zip Slip 対策**: `files/` 配下の各エントリ名を検証。`..` セグメント・先頭 `/`・
  ドライブレター・`\` を含むエントリは拒否(400)。展開先は `isPathInside` で
  新 projectRoot 配下であることを必ず確認。
- manifest 検証: `app === "guruguru" && kind === "project-export"`、
  `formatVersion` が対応値(1)以下でなければ 400。
- DB 書き込みは **1 トランザクション**(FK 順: shared → project → pages/templates →
  rounds → jobs/assets → …)。失敗時はロールバックし、コピー済みファイルを削除。
- ファイル展開はトランザクション確定前に新 projectRoot へ行い、DB 失敗時に
  `deleteProjectStorage` で掃除する。
- `files/`の全エントリを先にZip Slip検証してから、展開と`writeFile`を最大8並列で実行する。各workerでも
  `isPathInside`を維持し、失敗時は実行中workerの終了を待ってからstorageを削除する。

## 6. UI

- プロジェクト一覧: 各プロジェクトカードに「エクスポート」(ダウンロード)、
  一覧ヘッダに「インポート」(`<input type="file" accept=".gguru">`)。
- インポート成功後は新プロジェクトを一覧先頭へ追加して表示。warnings があればトースト等で表示。
- ホームへ戻る時に脚本画面・選択script・Manga Run UIを破棄する。脚本画面を開く時も一覧取得前に
  `activeScriptId`をnullへ戻し、新projectIdと旧scriptIdを組み合わせた先行API呼び出しを防ぐ。
- クライアントは既存の `api.ts` / `downloadUtils.ts` / actionRegistry のパターンに従う。

## 7. テスト(bun test)

- ラウンドトリップ: プロジェクト(rounds/assets/pages/characters/binding/脚本を含む)を
  作成 → export → import → 新プロジェクトの行数一致・ID が全て新規・パスが新 projectRoot
  配下を指す・参照整合(FK)・ファイル実在、を検証。
- Zip Slip: `files/../evil.txt` エントリを含む zip が 400 になり、ファイルが書かれないこと。
- formatVersion 超過の拒否。
- 進行中 status の正規化(§4)。
- shared テンプレートの再利用(既存 ID がある場合に重複 INSERT しない)。
- ZIP central directoryを検査し、画像がSTORE、manifest/data/テキストがDEFLATEであること。
- 旧版相当の全DEFLATE ZIPが展開できること。

## 8. 非スコープ(v1)

- アプリ設定(app_settings)・ComfyUI 側モデル/LoRA ファイルのエクスポート
- 部分エクスポート(ページ単位等)、差分マージインポート
- 旧 formatVersion からのマイグレーション(v1 が初版)

## 9. 変更履歴

- 2026-07-14: 画像等をSTORE、テキストをDEFLATEとする混在ZIPへ変更し、files展開をZip Slip検証維持の
  最大8並列へ変更。全DEFLATE旧ファイル互換を回帰テスト化。インポート後に旧scriptIdが残るクライアント状態も修正。
- 2026-07-12: formatVersion 1の`.gguru`仕様を策定。
