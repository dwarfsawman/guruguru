# 引継ぎメモ: Consistent Character 機能 Phase 5(実機生成検証)

作成: 2026-07-07。前セッションのコンテキストウィンドウ逼迫のため引継ぎ。
**このファイルは一時的な引継ぎメモ。Phase 5 完了後は内容を `Docs/Feature-ConsistentCharacter.md` に統合してこのファイルは削除してよい。**

**追記(同日、引継ぎ直後の確認)**: `curl http://127.0.0.1:8288/system_stats` と `curl http://127.0.0.1:3000/api/settings/comfy` で両サーバの生存を確認済み。GURUGURU(3000)の ComfyUI 接続先設定は `http://127.0.0.1:8288` のまま維持されている。**新セッションはまずこの2つの curl で疎通確認すれば、再起動不要でそのまま Phase 5 の続き(参照画像アップロード→生成)に進めるはず。**

## タスク全体像

ユーザー提供の ComfyUI ワークフロー `Consistent Character Chroma.json`(`~/Downloads/consistentCharactersFaceAndBody_v10/`)の機能を GURUGURU に取り込む。
詳細設計・確定事項は **`Docs/Feature-ConsistentCharacter.md`**(このファイルと同じ Docs フォルダ)を必ず読むこと。要点:

- 顔スタイル参照(PuLID-Flux)・全体スタイル参照(IP-Adapter)・Hyper-Chroma 低ステップ LoRA・IP-Adapter 用 RMBG 背景除去を、**導入済みモデル/ノードパックに応じて自動 ON/OFF** するフラグメント注入方式で実装。
- 参照画像 UI は生成フォームの親画像取り込み直下(顔/スタイルは同じ1枚を共用)。
- 作業場所: **git worktree `C:\Users\<user>\work\TypeScriptWorks\guruguru-wt-consistent-char`、ブランチ `feature/consistent-character`**。メインチェックアウト(`C:\Users\<user>\work\TypeScriptWorks\guruguru`)は触らない。
- **まだ main へマージしていない。** ユーザーは「テスト用 ComfyUI(8288)に PuLID 等を導入して実生成まで検証」を明示的に選んだ(Phase 5 完了後にマージ判断を仰ぐこと。まだ「マージしてよい」の確認は取っていない)。

## 完了済み(Phase 0〜4、全部コミット済み)

worktree 内で `git log --oneline` すれば経緯が追える。要点だけ:

- **Phase 0**: `Docs/Feature-ConsistentCharacter.md` 起票。
- **Phase 1**: 実機へのカスタムノード導入はせず(当時は依存追加のリスク判断で保留)、GitHub 上のソース(`PaoloC68/ComfyUI-PuLID-Flux-Chroma` の `pulidflux.py`、`XLabs-AI/x-flux-comfyui` の `nodes.py`、`yolain/ComfyUI-Easy-Use` の `py/nodes/image.py`)を直接読んで正確な入力名を確定。**Phase 5 の実機検証でこの内容が完全に正しかったことが確認済み**(下記参照)。
- **Phase 2**: `src/shared/workflowModels.ts` に `ModelKind`(pulid/ipadapterFlux/clipVision 追加)と `FeatureKey` タクソノミ。`src/server/modelCheck.ts` を `runRawCheck()` で共通化し、UI 向け `checkModels()`(features[] 追加)と生成時ゲート用 `resolveFeatureAvailability()`(10秒キャッシュ)の両方から使えるようにした。ついでに `matchRequirements` の照合キーを `loaderClass` 単体から `loaderClass::inputName` 複合キーへ修正(LoadFluxIPAdapter のように同一クラスが異なる入力名で2モデル要求するケースの取り違えバグ)。
- **Phase 3**: 新規 `src/server/workflowFeatureFragments.ts` — `assembleFeatureFragments()`(LoRA→IP-Adapter→PuLID の順で MODEL チェーンへ splice、参照画像 LoadImage ノードは PuLID/IP-Adapter で共有)と `pruneControlNetBranch()`(ControlNet モデル未配置時に CFGGuider.positive/negative を CLIPTextEncode へ直結しCN関連ノードを削除)。`workflowUnifiedSwitch.ts` の `patchUnifiedSwitchWorkflow` に接続。`rounds.ts` に参照画像アップロード + ラウンド単位の `resolveFeatureAvailability()` 呼び出し。単体テスト25件追加。
- **Phase 4**: 生成フォームに「参照画像」枠(新規 `referenceController.ts`)。顔/スタイルトグルは `state.modelCheck.result.features` に基づき disabled + tooltip。Project 展開時に `refreshModelCheck("chroma")` を先行実行。`workflowUi.ts` の install モーダルを feature別カード表示に拡張(`requiredNodePacks`/`missingNodePacks`)。**実機ブラウザ検証**(本番 ComfyUI 8188 への疎通確認レベル API 呼び出しのみ、生成はしていない)で全て確認し、ネストしたテーブルの CSS 折り返しバグを発見・修正済み。

`npm test` 381/381、`npm run typecheck` 0エラー、いずれも最新コミット時点で確認済み。

## Phase 5 進行中: 実機生成検証

ユーザーが「テスト用 ComfyUI(8288)に PuLID 等を導入して実生成まで検証」を選択したため着手。

### やったこと(完了)

1. **テスト用 ComfyUI(8288)の custom_nodes へ実導入**:
   ```powershell
   cd "$env:TEMP\comfy-test-8288\custom_nodes"
   git clone --depth 1 https://github.com/PaoloC68/ComfyUI-PuLID-Flux-Chroma.git
   git clone --depth 1 https://github.com/XLabs-AI/x-flux-comfyui.git
   ```
2. **Python 依存関係を共有 `standalone-env` へインストール**(ユーザー承認済みのリスク許容):
   ```bash
   PYEXE="$LOCALAPPDATA/Comfy-Desktop/ComfyUI-Installs/ComfyUI/standalone-env/python.exe"
   "$PYEXE" -m pip install -r ".../custom_nodes/x-flux-comfyui/requirements.txt"
   "$PYEXE" -m pip install -r ".../custom_nodes/ComfyUI-PuLID-Flux-Chroma/requirements.txt"
   ```
   **insightface を含め全て prebuilt wheel でインストール成功(Python 3.13、コンパイル不要)。依存関係の破壊は起きていない。**
3. **テスト用 ComfyUI(8288)を起動**(操作メモ.md の手順どおり)。custom_nodes 2件とも import エラーなしでロード確認済み(`server.log` に import 時間ログのみ、エラーなし)。
4. **`/object_info` で全ノードクラスを実機確認 — Phase 1 のソース読解と完全一致**:
   - `ApplyPulidFlux`: model/pulid_flux/eva_clip/face_analysis/image + weight/start_at/end_at/fusion/fusion_weight_max/fusion_weight_min/train_step/use_gray + optional attn_mask/prior_image — 予想どおり
   - `PulidFluxModelLoader.pulid_file` choices = `["pulid_flux_v0.9.1.safetensors"]` — **重要な発見**: 元ワークフロー(Phase 1 の参照元)は `v0.9.0` だったが、共有モデルディレクトリ(`$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Shared\models\pulid\`)には既に **`pulid_flux_v0.9.1.safetensors`** が配置されていた。**`src/server/workflowFeatureFragments.ts` の `PULID_FILE` 定数を `v0.9.1` に修正済み・コミット済み**(コミット `460d7d0`)。
   - `LoadFluxIPAdapter`: `ipadatper`(タイポ原文ママ)/`clip_vision`/`provider` — 予想どおり。ただし両方とも choices が空配列(`ip_adapter.safetensors`・`clip-vit-large-patch14.safetensors` はまだ未配置)
   - `ApplyAdvancedFluxIPAdapter`: `smothing_type`(タイポ原文ママ)の選択肢 `["Linear", "First half", "Second half", "Sigmoid"]` — 予想どおり
5. **共有モデルディレクトリの既存ファイルを確認**:
   - `models/pulid/pulid_flux_v0.9.1.safetensors` ✅ 既にある
   - `models/controlnet/diffusion_pytorch_model.safetensors` ✅ 既にある(base template の CN モデルと一致)
   - `models/xlabs/`、`models/insightface/` ディレクトリは無い(x-flux-comfyui/insightface が初回起動時に自動作成するはずだが、`ip_adapter.safetensors`・`clip-vit-large-patch14.safetensors` は無い)
   - `models/loras/` に Hyper-Chroma LoRA は無い
6. **GURUGURU 側の実機確認**: テスト用インスタンス(PORT 3000、`GURUGURU_TEST_DB=1`)を起動し ComfyUI 接続先を `http://127.0.0.1:8288` に変更。`GET /api/comfy/model-check?family=chroma` で:
   ```json
   "pulid": { "available": true, ... }       // ノード+モデルファイル両方揃って有効化！
   "ipadapter": { "available": false, "missingNodePacks": [] }  // ノードは有るがモデルファイル無し
   "rmbg": { "available": false, "missingNodePacks": [{"label":"comfyui-easy-use",...}] }  // ノード自体が無い(8288にcomfyui-easy-use未導入)
   "controlnet": { "available": true, ... }
   "lora": { "available": false, ... }  // Hyper LoRA ファイル無し
   ```
   → プロジェクトを開いてサイドバーを確認したところ **「顔スタイル参照(PuLID)」トグルが disabled=false(有効)、「全体スタイル参照(IP-Adapter)」は disabled=true** — 設計どおりの差別化された挙動を実機で確認できた。
7. **テンプレート登録**(UI からのインポートは Phase 4.5 で削除済みのため API 直叩き):
   ```bash
   node -e "
   const fs = require('fs');
   const workflow = JSON.parse(fs.readFileSync('Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json', 'utf8'));
   const body = JSON.stringify({ name: 'CC Unified Switch', description: 'test', type: 'hybrid', workflowJson: workflow, roleMap: {} });
   fs.writeFileSync('<scratchpad>/template-body.json', body);
   "
   curl -X POST http://127.0.0.1:3000/api/templates -H "content-type: application/json" --data-binary @<scratchpad>/template-body.json
   ```
   → テストDB に登録済み(「CC UI Test」プロジェクト、「CC Unified Switch v1」テンプレート)。**このテストDBは `GURUGURU_TEST_DATA_DIR` のパスに永続化されているので、同じ launch.json 設定で再起動すれば残っている可能性が高い(ただし %TEMP% 配下でセッションIDに紐づくパスのため、消えていたら再登録すればよいだけ、上記コマンドを再実行)。**

### 次にやること(未完了・ここで中断)

**目標**: 参照画像(顔写真)を実際にアップロードし、「顔スタイル参照(PuLID)」を ON にして実際に txt2img 生成を実行し、ComfyUI が PuLID ノードを含むグラフを正常に実行できることを確認する(顔の再現度そのものの品質評価は必須ではない。**パイプライン全体が動くこと**の確認が目的)。

**詰まった場所**: サンドボックス化された preview ブラウザ(Claude_Preview ツール群)のフォームに画像ファイルをどう注入するかで詰まった。試した方法と結果:

1. **`preview_eval` で `fetch()` を使い別ポート(8796)から画像を取得 → 失敗**。`TypeError: Failed to fetch`。python 製の別ポートサーバ(CORSヘッダ付きでも)へ preview ブラウザ内の JS から到達できない(サンドボックスのネットワーク制限と思われる)。Bash からの `curl` でも同じポートへの疎通が不安定だった(exit 7/28)。**この方向は諦めるのが吉。**
2. **base64 を `preview_eval` に直接埋め込む → 動くが激重い**。1x1px ダミー画像では成功したが、実写真(86KB PNG)を Read すると**80828トークン**消費した(コンテキスト圧迫の直接原因)。JPEG品質60・192x192程度まで圧縮すると **5.5KB / base64で7448文字** まで縮小でき、これなら妥当なコスト(数千〜1万トークン程度)で埋め込める。**この方法が唯一動作確認済みの経路。**
3. **`claude-in-chrome` の `file_upload` ツール → 権限で拒否**。実ファイルパスを直接ブラウザの file input へ注入できる強力なツールだが、「ユーザーがこのセッションに共有したファイルのみアップロード可」という制約があり、scratchpad・worktree直下・Downloads いずれのパスも `"Cannot upload ...: only files the user has shared with this session can be uploaded."` で拒否された。**この経路は現状ブロック**(ユーザー自身がファイルを添付/共有すれば通る可能性はあるが、こちらから解決する手段が無い)。

**推奨する次の一手**: 方法2(縮小 JPEG を base64 で `preview_eval` に直接埋め込み)をそのまま完遂する。手順:

```bash
# 新セッションの scratchpad パスは異なるので、以下は都度そのセッションのパスに読み替える
PYEXE="$LOCALAPPDATA/Comfy-Desktop/ComfyUI-Installs/ComfyUI/standalone-env/python.exe"
"$PYEXE" -c "
from skimage import data
from PIL import Image
img = data.astronaut()  # scikit-image 同梱のパブリックドメイン顔写真(飛行士 Eileen Collins、ライセンス懸念なし)
im = Image.fromarray(img)
face = im.crop((150, 30, 400, 280)).resize((192,192))
face.convert('RGB').save('<新セッションのscratchpad>/test-face-tiny.jpg', quality=60)
"
```
そのあと `Read` ツールでこの jpg の base64 を得るのではなく、**Node.js の `fs.readFileSync(...).toString('base64')` を Bash で実行してファイルに書き出し、その `.b64` ファイルを `Read` する**(実際に約7448文字で収まることを確認済み。Read前にファイルサイズを `wc -c` で確認してから読むこと)。

その base64 文字列を使い、GURUGURU の preview ブラウザ(`preview_start` name=`guruguru-preview-consistent-character`)で以下のように file input へ注入する(前セッションで 1x1px ダミー画像に対して成功させた実績のあるコード):

```js
(function(){
  const b64 = "<ここに base64 文字列>";
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const file = new File([bytes], "test-face.jpg", { type: "image/jpeg" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('input[data-reference-upload]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched';
})()
```

そのあと:
1. 「顔スタイル参照(PuLID)」チェックボックスをトグル(`[data-action="toggle-reference-face"]`。**`preview_click` が空振りすることがあるので `preview_eval` で `element.click()` を直接呼ぶ**(既知の対処、memory の `preview-click-flaky-workaround` 参照)。
2. 生成を実行(`data-action="generate-round"` 相当のボタン。サイドバー最下部の生成ボタンを `find`/`snapshot` で探す)。
3. `preview_network` や `curl http://127.0.0.1:3000/api/rounds/:roundId` 等でラウンドの `status`/`last_error_json` を確認。
   - **成功** → PuLID を含む実生成が確認できる(最も望ましい)
   - **ComfyUI 側 execution_error(顔検出失敗等)** → それでも「PuLIDノードまで到達して実行された」ことの証明にはなる(パイプライン結線は正しいと判断できる)。エラー内容次第でさらに追加確認するかはユーザー判断
4. 結果を `Docs/Feature-ConsistentCharacter.md` の Phase 5 実施記録として追記。

### 環境の現在の状態(このセッション終了時点)

- **テスト用 ComfyUI**: `127.0.0.1:8288` で起動中(のはず。Bash の `nohup ... &` で起動したプロセスなので、エージェントプロセス終了後も生き残っているか不確実。**新セッションでまず `curl --max-time 5 http://127.0.0.1:8288/system_stats` で疎通確認し、死んでいたら操作メモ.md の手順で再起動**)。
  - base directory: `%TEMP%\comfy-test-8288`
  - custom_nodes: `ComfyUI-PuLID-Flux-Chroma`、`x-flux-comfyui` を clone 済み(依存関係インストール済み)
  - ログ: `%TEMP%\comfy-test-8288\server.log`
- **GURUGURU dev サーバ**: `127.0.0.1:3000` で起動中(のはず。`preview_start` name=`guruguru-preview-consistent-character` で管理。**新セッションでは `preview_list` でまず既存サーバ一覧を確認し、無ければ `preview_start` で再起動**)。
  - ComfyUI 接続先はテストDB内の設定で `http://127.0.0.1:8288` に変更済み(再起動しても DB の設定は残るはず。念のため設定画面で確認)
  - テストDB: `GURUGURU_TEST_DATA_DIR`(メインリポジトリの `.claude/launch.json` 内の `guruguru-preview-consistent-character` エントリの env を参照。このセッションのスクラッチパス配下なので**別セッションでは異なるパスになりうる** — もし空なら「CC UI Test」プロジェクト作成 + 上記の template 登録 curl を再実行すればよい)
- `.claude/launch.json`(メインリポジトリ側、gitignore 対象・未追跡)に `guruguru-preview-consistent-character` と(不要になった)`cc-test-assets` の2エントリを追加済み。`cc-test-assets` は動作しなかったので削除してよい。

### 使い残しの調査画像ファイル(セッション固有パスなので消えている可能性あり)

- `<このセッションのscratchpad>/test-face-tiny.jpg`(5.5KB、圧縮済みテスト顔画像)
- `<このセッションのscratchpad>/tiny.b64`(7448文字、上記の base64)

**新セッションでは上記の Python コマンドで作り直すのが確実**(scikit-image の astronaut サンプルはパブリックドメインでライセンス・プライバシー懸念なし。ユーザー個人の写真(Downloads や Pictures)は絶対に使わないこと — 前セッションでも意図的に避けた)。

## Phase 5 完了後にやること

1. `Docs/Feature-ConsistentCharacter.md` に実生成検証の結果を追記、このファイル(`Handoff-Phase5-ConsistentCharacter.md`)は削除して統合。
2. `操作メモ.md` の変更履歴に一行追記(このリポジトリの規約)。
3. **ユーザーに main へのマージ可否を確認してから**マージする(まだ確認していない。push は依頼時のみ)。
4. IP-Adapter(x-flux-comfyui のモデルファイル)・RMBG(comfyui-easy-use 導入)・Hyper LoRA の完全な実生成検証は、モデルファイルのダウンロードが必要な追加作業として、今回のスコープに含めるかユーザーに確認(必須ではなく、コード自体は実機の feature-availability 判定とユニットテストで検証済み)。
