# エージェント向けインスタンス / 画像生成 API

## インスタンス境界

`bun run start:agent` はユーザー用 `5177` と分離した、エージェント向けの永続インスタンスを起動する。
既定は `127.0.0.1:5199`、データは Windows では `%LOCALAPPDATA%\GURUGURU-AGENT` に保存される。
これは `GURUGURU_TEST_DB=1` の一時DBではなく、通常DBと同じmigration・永続化を使う独立インスタンスである。

- ポート変更: `GURUGURU_AGENT_PORT`（`5177` は拒否）
- データ場所変更: `GURUGURU_AGENT_DATA_DIR`（リポジトリ内は拒否）
- 既定ComfyUI変更: `GURUGURU_DEFAULT_COMFY_BASE_URL` / `GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL`
- ランチャーは親シェルの `GURUGURU_TEST_DB` / `GURUGURU_TEST_DATA_DIR` / `NODE_ENV` を子へ引き継がない。
- 既定ComfyUIは隔離インスタンス `http://127.0.0.1:8288`。永続DBですでに設定を保存済みなら、その保存値を優先する。

`GET /api/health` の `instanceMode` は `agent`、`GET /api/agent/capabilities` の `agentReady` は `true` になる。

### エージェントCLIと同一コンテキストURL

外部エージェントの漫画制作はGUI操作ではなく、同梱CLIからGURUGURU HTTP APIを使う。CLIはruntime DBや
ComfyUIの生成内容へ迂回せず、GUIと同じサーバー・同じ保存／検証経路を通る。

```powershell
# 実インスタンス、project、script、最新の固定revisionと任意のcandidate/run/taskの所属を検査する
bun run agent:cli -- --base-url http://127.0.0.1:5199 context --project-id <project-id> --script-id <script-id> --candidate-id <candidate-id>

# 任意のGURUGURU APIを操作する。大きいrequestはrepository外のJSONファイルを使う
bun run agent:cli -- --base-url http://127.0.0.1:5199 api POST /api/projects/<project-id>/script-manga-plan-candidates --json-file <request.json>

# 組み込みLLM/VLMの実可用性から、組み込み／外部エージェント経路を選ぶ
bun run agent:cli -- --base-url http://127.0.0.1:5199 route

# 外部planを固定revisionのName Studio候補へ取り込み、隔離snapshotで実materialize相当を検査する
bun run agent:cli -- --base-url http://127.0.0.1:5199 candidate import --project-id <project-id> --script-id <script-id> --revision-id <revision-id> --plan-file <plan.json> --group-id <group-id>
bun run agent:cli -- --base-url http://127.0.0.1:5199 candidate preflight --candidate-id <candidate-id> --template-id <template-id> --json-file <run-settings.json>

# 人間専用ゲートでない場合はGUIボタンを介さず採用し、candidateとrunを同じ応答で受け取る
bun run agent:cli -- --base-url http://127.0.0.1:5199 candidate adopt --candidate-id <candidate-id> --template-id <template-id> --json-file <run-settings.json>

# 外部visionエージェントの正式な候補監査結果を登録する
bun run agent:cli -- --base-url http://127.0.0.1:5199 audit record --task-id <task-id> --json-file <audit-result.json>

# 無人運転または明示的な監視依頼でだけ待つ(attended人間ゲートでは使わない)
bun run agent:cli -- --base-url http://127.0.0.1:5199 wait candidates --project-id <project-id> --script-id <script-id> --status adopted --interval 15 --timeout 0
bun run agent:cli -- --base-url http://127.0.0.1:5199 wait run --run-id <run-id> --field approvalStatus --equals approved --interval 15 --timeout 0

# 候補画像やexportなどbinary応答をAPIから取得する
bun run agent:cli -- --base-url http://127.0.0.1:5199 api GET /api/assets/<asset-id>/image --output <outside-repository-path>
```

`context`のJSONに含まれる`guiUrl`が人間ゲート用の正規URLである。これはbare URLではなく
`projectId`、`scriptId`、`revisionId`と、指定時の`candidateId`、`runId`、`planId`、`taskId`を含む。
Script画面は起動時にそれぞれの所属をAPIで再検証し、CLIと異なるコンテキストを暗黙選択しない。
エージェントはURLを推測したり、GUIスクリーンショットからIDを読み取ったりしない。人間への案内では、正規URLを
コピーできるfenced code blockで必ず全文表示する。ユーザーがChromeを明示しChrome操作が使える場合は、同じURLを
Chromeへnavigation-onlyで開いてよいが、その後のGUI操作は人間へ委ねる。Chromeを使えない場合もコピー用URLを案内できる。

attendedな人間ゲートでは`agent:cli wait`を実行し続けない。URLを渡したらエージェント処理を終了し、ユーザーが
選択・承認後にタスクを再開した時だけ、候補またはrunをAPIで一度取得する。期待状態でなければ定期pollへ移らず、
その時点の状態を一度報告して再び終了する。`wait`コマンドは無人運転や明示的な監視依頼のために残す。

bareなインスタンスURLを人間が開いた場合も、Project一覧は`GET /api/projects`を5秒ごと
(バックグラウンド時は20秒ごと)に更新する。Bookカードには最新のactiveネーム候補または最新runを
「ネーム選択待ち」「演出ネーム・参照承認待ち」「漫画生成中」「画像候補の確認待ち」「完了」等で表示する。
「進捗を開く」は同じproject/script/revision/candidateまたはrun/planを含む正規URLへ移動する。
これはDBへ保存済みのGURUGURU状態を示すもので、まだ応答が完了していない単発CLIプロセス自体の標準出力ではない。

### 漫画エージェント専用API

| Method / path | 用途 |
| --- | --- |
| `GET /api/llm/status` | `/models`疎通に加えて設定modelの列挙有無を`modelListed`で返す。`ok:false`なら外部plan経路 |
| `GET /api/vlm-audit/status` | 組み込みVLMのready/on-demand/unavailable判定。`ok:false`なら外部監査経路 |
| `POST /api/projects/:projectId/script-manga-plan-candidates/import` | `{scriptId,scriptRevisionId,plan,groupId?,profile?,agent?,model?,notes?}`を固定revision候補へimport。構造重複は既存候補へupsert |
| `POST /api/script-manga-plan-candidates/:candidateId/preflight` | 隔離DBで実レタリングと全panel preflightを検査。成功した組み込み候補だけ検査済み演出planへ固定する |
| `POST /api/script-manga-plan-candidates/:candidateId/adopt` | full preflightを自動再実行して全ページを採用。初回`{candidate,run,preflight}`、再送`{candidate,run}`。外部／固定済み候補は組み込みLLMを呼ばない |
| `POST /api/script-manga-tasks/:taskId/audit-results` | manual runの候補assetへ外部監査reportをupsertし`{report,run}`を返す。明示FAIL assetはselect拒否 |

`preflight`はmaterialize失敗もHTTP 200で`ok:false`と`issues`を返す。CLIはこれをexit code 2へ変換するため、エージェントはHTTP例外の文字列解析ではなく構造化issueを修復ループへ渡せる。reportの`materializationIdsEphemeral:true`が示すtask/page/panel IDは破棄済みsnapshot内の一時IDで、後続audit/selectには使わない。`skippedChecks`のReference Set・画像生成・画像監査は採用後の各gateで行う。

成功した組み込み候補は検査した演出planへ固定され、`candidateDirectionFrozen:true`、新しい`candidateEditVersion`、演出条件hash/modelが返る。失敗時はcandidate不変である。監督LLMのbatch fallbackは成功扱いにせず503となる。固定済み組み込み候補へ別のcharacter bible、style、密度条件を渡すと409になり、検査時と同じ条件を使う必要がある。

`adopt`は同じ設定でpreflightを必ず再実行し、失敗時はHTTP 422の`{error,preflight}`を返す。CLIはこのresponse全体を構造化JSONでstderrへ出しexit code 2にする。成功時の正は同じ応答内の`candidate.status:"adopted"`と`candidate.adoptedRunId === run.id`であり、GUIクリックや後続pollから成立を推測しない。汎用run作成APIは`planCandidateId`を拒否し、候補採用をこのgateへ集約する。

外部監査のrequestは次の形に限定され、raw prompt・画像data・API keyなどの余剰項目は保存しない。同じ`assetId`の再登録はreportを置換する。

```json
{
  "assetId": "asset_...",
  "passed": false,
  "score": 0.35,
  "checks": { "visualIdentity": "fail", "actionAlignment": "pass", "fakeText": "pass" },
  "violations": ["planned character identity does not match"],
  "reviewer": "codex",
  "model": "external-vision-model",
  "notes": "regenerate this candidate"
}
```

### ページ共有(ネームスタジオの人間ゲート)

UIとAPIは同一サーバー・同一ポートなので、人間が`context`の返した`guiUrl`を開けばネームスタジオを共有できる。

- ユーザーインスタンス(5177)は `HOST` 未指定なら全インターフェースへbindするため、
  LAN/Tailscale の IP で `http://<host>:5177` を開くだけでよい(起動ログの 127.0.0.1 表記は飾り)。
- エージェントインスタンス(5199)は既定 loopback。共有時は `HOST=0.0.0.0`(または Tailscale IP)を
  付けて `bun run start:agent` を起動する。
- 注意: `dev-hot.mjs` のライブリロードsnippetは 127.0.0.1 固定なので、リモート閲覧者には
  自動リロードが効かない(本番build を使うエージェントインスタンスには無関係)。script 画面自体は
  5秒毎(バックグラウンドタブは20秒毎)のポーリングでライブ更新される。
自動テストや使い捨てsmokeは引き続き `GURUGURU_TEST_DB=1` / `bun run start:test` を使い、エージェント用永続DBをテストfixtureにしない。

## Anima APIフロー

APIはUIと同じ保存・検証経路を使う。画像はData URLで送り、サーバーがRound専用ファイルへ保存した後、DBにはData URLを残さない。

1. `POST /api/model-presets/anima` でINT8 Animaプリセットを追加し、返された `template.id` を保持する。
2. `POST /api/projects` でプロジェクトを作る。img2img/inpaintでは、先に `POST /api/projects/:projectId/source-assets` へ元画像をData URLで送り、返された `asset.id` を保持する。
3. `POST /api/projects/:projectId/rounds` で生成する。
4. `POST /api/rounds/:roundId/collect` で完了画像を収集する（通常はサーバー監視も自動収集する）。

共通のAnima既定値は `sampler: "er_sde"`、`scheduler: "simple"`、`steps: 30`、`cfg: 4`。INT8本体は
`animaInt8Mxfp8_aestheticV11Int8.safetensors` で、`UNETLoader.weight_dtype` は `default` のまま使用する。

### inpaint

`generationMode: "img2img"`、`parentAssetId`、親画像と同寸法のPNG Data URLを `inpaint.maskDataUrl` に指定する。

```json
{
  "templateId": "<anima-template-id>",
  "prompt": "masterpiece, best quality, score_7, safe, ...",
  "negativePrompt": "worst quality, low quality, ...",
  "seed": 12345,
  "seedMode": "fixed",
  "batchSize": 1,
  "steps": 30,
  "cfg": 4,
  "sampler": "er_sde",
  "scheduler": "simple",
  "denoise": 0.7,
  "width": 768,
  "height": 768,
  "generationMode": "img2img",
  "parentAssetId": "<source-asset-id>",
  "inpaint": {
    "maskDataUrl": "data:image/png;base64,...",
    "maskedContent": "original",
    "inpaintArea": "only_masked",
    "onlyMaskedPadding": 6
  }
}
```

Animaは既存のlatent mask経路だけでもinpaintできる。`AnimaLLLiteApply` と
`anima-lllite-inpainting-v2.safetensors` がある場合は、親画像+白=inpaint領域のmaskを4ch LLLiteにも渡して補助する。

### ポーズControlNet / inpaint併用

OpenPose画像のPNG Data URLを `controlnet.poseImageDataUrl` に指定する。txt2imgへ添付できるほか、上記inpaint bodyへ同じオブジェクトを追加して併用できる。

```json
{
  "controlnet": {
    "poseImageDataUrl": "data:image/png;base64,...",
    "strength": 0.8,
    "startPercent": 0,
    "endPercent": 0.85
  }
}
```

Anima ControlNetはChroma用 `ControlNetApplyAdvanced` を流用しない。`ComfyUI-Anima-LLLite` の
`AnimaLLLiteApply` と `models/controlnet/anima-lllite-pose-1.safetensors` を使い、MODELチェーンを
`UNET → ユーザーLoRA → In-Context（任意）→ inpaint LLLite（任意）→ pose LLLite（任意）` の順に組む。
複数LLLiteは `preserve_wrapper=true` でcascadeする。ノードまたはpose weightが無い場合は、ControlNet画像を黙って無視せず生成前に明示エラーにする。

## モデル確認

`GET /api/comfy/model-check?family=anima` はベースINT8/encoder/VAEに加え、次の任意機能を個別表示する。

- `animaInpaint`: `AnimaLLLiteApply` + `anima-lllite-inpainting-v2.safetensors`
- `animaControlnet`: `AnimaLLLiteApply` + `anima-lllite-pose-1.safetensors`
- `animaInContext`: 既存のadapter/node pack

LLLite node packとweightはGURUGURUへ同梱・自動取得しない。導入・利用前に各配布元とAnima本体のライセンスを確認する。
隔離Composeではユーザー共有modelsをread-onlyのまま保ち、agent固有のINT8本体とLLLite weightを
`guruguru-sandbox_comfy-agent-models` volumeの`diffusion_models/` / `controlnet/`へ置く。
pose-1はPreview3世代のweightで、[配布元model card](https://huggingface.co/kohya-ss/Anima-LLLite)によれば
Anima-Base v1.0派生でも利用できるものの品質低下があり得る。
