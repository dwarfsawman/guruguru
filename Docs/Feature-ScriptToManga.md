# Feature: Script-to-Manga 下地(S1〜S4)

最終目標: **Fountain 脚本を入力すると、guruguru が自動でコマ割りを行い、各コマに適した画像生成を行い、セリフも自動生成して漫画ページを完成させる。**

本ドキュメントはその下地となる 4 つのサブプロジェクト(S1〜S4)の設計書。将来の画像生成モデルの進化
(ページ一発生成・透過出力・外部 API 型モデル等)に「全体改修」ではなく「アダプタ追加」で追随できる構造と、
コマをまたぐ表現(立ち絵ぶち抜き)・セリフ自動生成のためのドメインモデルを整える。

- ステータス: S1〜S4 実装中(ブランチ: `s1-generation-provider` / `s2-image-object` / `s3-script-domain` / `s4-dialogue-llm`、順にレビュー後 main へマージ)
- 前提調査: 2026-07-10 に生成経路/DB/ページオブジェクト/書き出し/Book UI/LLM/API 慣例の 7 領域を精査済み。本文中の行番号はその時点のもの。

---

## 0. 全体像とモデル性能マトリクス

```
[Fountain 脚本] ──parse──> [MangaScript / Character / DialogueLine]   … S3
        │                          │
        │ (将来: LLMでコマ割り選定) │ (S4: LLMセリフ提案 → DialogueLine)
        v                          v
[PageLayout(コマ割り)] ──> [コマ別 GenerationIntent] ──> [GenerationProvider] … S1
                                   │                        │
                                   │              ComfyProvider / 将来の外部API Provider
                                   v                        v
                  [コマ割当 + ImageObject(前景立ち絵) + 吹き出し]         … S2 + 既存P1〜P6
                                   v
                  [ページ合成(preview / ORA / PNG 書き出し)]              … 既存
```

想定する新モデルと対応方針:

| 想定モデル | 対応 | 下地 |
|---|---|---|
| ComfyUI 内の新チェックポイント/標準ワークフロー | テンプレ+role map 追加(現状でも可) | S1 で capability snapshot が付く |
| ComfyUI 内の独自ノード・独自制御 | ComfyProvider の patch/能力判定を拡張 | S1 |
| 外部 API・別実行基盤 | Provider を1個追加(rounds/UI は不変) | S1 |
| 透過出力できるモデル | `capabilities.transparentOutput` → ImageObject へ直行 | S1+S2 |
| ページ一発生成モデル | `capabilities.pageGeneration` → ページ対象 Intent | S1(将来フェーズで接続) |
| 文字も描けるモデル | **使わない**。文字は guruguru が吹き出しとして描く | S3/S4 の方針 |

セリフは画像モデルに描かせない。縦書き・fontkit グリフパス・吹き出し・書き出しを既にアプリ側で制御できて
いるため、AI は「台詞案(構造化データ)」を返し guruguru が配置する。文字化けせず、後編集・翻訳・フォント
変更に強い。

将来フェーズ(本下地の範囲外、下地が前提):
- **F1 自動コマ割り**: 脚本のシーン/拍数から layout_templates を LLM が選定・調整
- **F2 コマ別 Intent 合成**: シーン記述+Character の視覚参照(顔参照/LoRA)から各コマの GenerationIntent を自動構築
- **F3 前景立ち絵パイプライン**: 透過出力モデル or 既存 webSAM(`src/client/websam/`)切り抜きで ImageObject を量産
- **F4 ページ一発生成**: pageGeneration 能力を持つ Provider へページ対象 Intent を投げ、結果をページへ

---

## S1: GenerationIntent / GenerationProvider 抽象化

### 目的
「何を作りたいか(Intent)」と「そのモデルでどう実行するか(Provider)」を分離する。最初の実装は既存
ComfyUI 実行を包む ComfyProvider のみ。**HTTP API(POST /rounds、collect、interrupt)とクライアントは無改修。**

### 現状の癒着(調査結果)
- `createGenerationRound`(src/server/rounds.ts:135-340)が唯一のオーケストレータだが、画像アップロード/
  workflow パッチ/queuePrompt/WS メッセージ語彙/history パース/SaveImage クラス判定まで Comfy 固有概念が直書き。
- `comfy.ts` は既にほぼ純粋な HTTP/WS クライアント、`patchWorkflow` は純関数。切れ目自体は明確。
- DB 列 `prompt_id` / `client_id` / `comfy_output_node_id` / `patched_workflow_json` に Comfy 語彙が焼き付き。
  → **列リネームはしない**(前例なし・ゴミ箱復元互換)。意味論を「provider ネイティブのジョブ参照/送信ペイロード」
  として再解釈し、本ドキュメントと型コメントに明記する。

### 新規モジュール
```
src/shared/generationIntent.ts   … Intent 型 + toGenerationIntent(request) 純関数 + テスト
src/server/providers/types.ts    … GenerationProvider IF / ProviderCapabilities / Submit/Collect 型
src/server/providers/registry.ts … getProvider(id) / listProviders()。初期登録は comfy のみ
src/server/providers/comfyProvider.ts … 既存 comfy.ts / workflow.ts / modelCheck.ts を委譲で包む
```

### GenerationIntent(モデル中立語彙)
```ts
interface GenerationIntent {
  version: 1;
  prompt: { positive: string; negative: string };
  canvas: { width: number; height: number };
  batchCount: number;                     // 1..32(独立ジョブ N 個の意味)
  seed: { mode: "fixed" | "random" | "increment" | "reuse_parent"; value: number | null };
  /** img2img 系の入力画像(親アセット or ペースト合成済みファイル)。 */
  source?: { imagePath: string; denoise: number } | null;
  inpaint?: { maskPath: string; maskedContent: MaskedContent; padding: number; feather: number } | null;
  /** 構図制御。kind は中立語彙(pose/edge)。 */
  control?: Array<{ kind: "pose" | "edge"; imagePath: string; strength: number; range: [number, number] }>;
  /** 人物同一性の参照(現実装は PuLID 顔参照)。 */
  identity?: { faceImagePath: string } | null;
  /** 絵柄スタイル。id は provider スコープの不透明文字列(Comfy では LoRA choice verbatim)。 */
  styles?: Array<{ id: string; strength: number }>;
  output?: { transparent?: boolean };     // 将来: 透過出力の要求
  /** 生成対象のメタデータ(workflow には注入されない。コマ自動割当に使用)。 */
  target?: { pageId?: string | null; panelId?: string | null };
  /** 助言的サンプリングパラメータ。provider は解釈可能な範囲で使い、無視してよい。 */
  sampling?: { steps?: number; cfg?: number; sampler?: string; scheduler?: string };
  /** provider 固有のエスケープハッチ。comfy: { templateId, generationMode } 等。 */
  providerOptions?: Record<string, unknown>;
}
```
判断基準: steps/cfg/sampler/scheduler は拡散モデル共通語彙なので advisory な `sampling` に置く。
LoRA 名・templateId・generationMode は Comfy 固有なので `styles[].id`(不透明)と `providerOptions.comfy` に隔離。

`toGenerationIntent(request: GenerationRequest): GenerationIntent` は正規化済みリクエスト
(prepare* 通過後、dataUrl→パス化済み)から導出する純関数。**GenerationRequest は当面クライアント wire 型として維持**
(壊すのは S1 の目的ではない)。

### GenerationProvider IF
```ts
interface ProviderCapabilities {
  providerId: string;
  displayName: string;
  modelFamily: string;                    // 例 "chroma"
  features: {
    img2img: boolean | null; inpaint: boolean | null;
    controlPose: boolean | null; controlEdge: boolean | null;
    identityReference: boolean | null;    // 顔参照
    styles: boolean | null;               // LoRA 等
    transparentOutput: boolean | null;
    pageGeneration: boolean | null;       // ページ一発生成(将来)
  };                                      // null = 未確認(ComfyUI 未接続等)
  checkedAt: string;
}

interface GenerationProvider {
  readonly id: string;
  getCapabilities(): Promise<ProviderCapabilities>;
  /** Intent がこの provider で実行可能かの事前検証(不足 capability を issues で返す)。 */
  validateIntent(intent: GenerationIntent): Promise<{ ok: boolean; issues: string[] }>;
  /** batchCount 個のネイティブジョブを投入。jobRef は不透明文字列(Comfy: prompt_id)。 */
  submit(ctx: ProviderSubmitContext): Promise<ProviderSubmittedJob[]>;
  /** jobRef の成果画像を取得(未完なら空配列)。Comfy: /history → /view。 */
  collectImages(jobRef: string, ctx: ProviderCollectContext): Promise<ProviderCollectedImage[]>;
  /** 実行中/待機中ジョブの中断。 */
  interrupt(jobRefs: string[]): Promise<void>;
  /** 進捗監視の開始(任意実装。Comfy: WebSocket)。 */
  watchProgress?(ctx: ProviderWatchContext): void;
}
```
`ProviderSubmittedJob = { jobRef: string; nativeSubmission: unknown; seed: number | null }`。
`nativeSubmission`(Comfy ではパッチ済み workflow)は先頭ジョブ分を従来どおり
`generation_rounds.patched_workflow_json` へ保存する(列名は据え置き、意味は「provider ネイティブ送信内容」)。

### rounds.ts の再編
- `createGenerationRound` は「検証 → prepare*(添付のファイル化)→ Intent 導出 → INSERT → provider.submit →
  jobs 記録」のオーケストレーションに徹する。Comfy 語彙(アップロード、dummy image、unified-switch 判定、
  patchWorkflow、queuePrompt)は全て `comfyProvider.submit` 内へ移す。
- `collectRoundUnlocked` の history パース(extractHistoryEntry/extractImages/selectFinalImages)と
  fetchViewImage は `comfyProvider.collectImages` へ。rounds.ts は「jobRef ごとに collectImages を呼び
  assets へ INSERT」する中立ループになる。
- `ensureRoundMonitor` / `handleComfySocketMessage` は `comfyProvider.watchProgress` へ。ジョブ状態遷移の
  通知はコールバック(`onJobUpdate(jobRef, status, error?)` / `onProgress(value, max)`)で rounds.ts に返す。
- `interruptRound` の queue 照合+/interrupt+/queue delete は `comfyProvider.interrupt` へ。
- ラウンド/ジョブの状態機械(updateRoundStatusFromJobs)・ロック・ゴミ箱・ツリーは **rounds.ts に残す**(中立)。

### DB(ensureColumn 追記、db.ts:285 以降)
```
generation_rounds.provider_id            TEXT NOT NULL DEFAULT 'comfy'
generation_rounds.intent_json            TEXT      … 導出した GenerationIntent(再現性・将来の re-run 用)
generation_rounds.provider_snapshot_json TEXT      … submit 時点の ProviderCapabilities
```
- jsonColumnNames(db.ts:22-33)へ `intent_json→intent`、`provider_snapshot_json→providerSnapshot` を登録。
- INSERT 更新箇所は rounds.ts:203 と sourceAssets.ts:58 の 2 箇所のみ(手動アップロードは provider_id='manual')。
- 秘密情報(将来の API キー)は列に置かず app_settings へ(SELECT * が全列 API 露出のため)。

### テスト
- `generationIntent.test.ts`: toGenerationIntent の全分岐(inpaint/controlnet/reference/loras/paste)。
- 既存 rounds.test.ts / workflow*.test.ts は無改修で緑を維持(挙動不変が受け入れ条件)。
- 検証 3 点セット: `bun run typecheck` / `bun test` / `bun run check`(check は build+health smoke のみな点に注意)。

---

## S2: ImageObject + レイヤー帯(コマぶち抜き立ち絵の土台)

### 目的
ページオブジェクトに「画像」を追加し、**コマ枠より後ろ/前**のレイヤー帯を導入する。これで
「コマ背景 → 枠の後ろの前景人物 → コマ枠 → 枠より前の人物 → 吹き出し・文字」の合成ができる。

### 型(src/shared/pageObjects.ts:95 の union へ追加)
```ts
export type ImageObjectBand = "back" | "front";   // back=コマ枠より後ろ(コマ画像より前)、front=枠より前(既定)

export interface ImageObject extends PageObjectBase {
  kind: "image";
  /** 参照アセット。書き出し/描画は assets.image_path / imageUrl を解決する。 */
  assetId: string;
  /** 幅・高さ(page 単位)。追加時は asset のアスペクト比で初期化。 */
  size: PageVec;
  opacity?: number;          // 0..1、既定 1
  band?: ImageObjectBand;    // 既定 "front"
  /** コマ形状でクリップ(コマ内に収める表現)。null/省略 = クリップ無し(ぶち抜き)。 */
  clipPanelId?: string | null;
}
```
- `normalizeImageObject` は **全フィールドを保持**すること(正規化往復で消えると保存 1 秒後に編集が巻き戻る。
  pageObjectsController.ts:171-173 の応答反映があるため必須)。
- text/balloon/box は従来どおり常に front 帯(型変更なし)。帯内の重なりは従来どおり配列順(先頭=背面)。

### 描画順(正)
```
Paper → コマ画像(order昇順) → [Objects back 帯(image のみ)] → コマ枠(Panels)
     → [Objects front 帯(image + text/balloon/box、配列順)] → Mosaic(最前面)
```

### サーバ書き出し(src/server/openRasterExport.ts)
- `createPageLayers`(L208-260): `appendObjectsLayer` を帯フィルタ付きで 2 回に分割。back 帯はコマ画像
  (L228-239)の後・`renderPanelFrameLayer`(L248-251)の前、front 帯は現行位置。レイヤー名は
  `"Objects (back)"` / `"Objects"`。レイアウト無し分岐(L211-223)も同様。
- `renderPageObjectElement`(L461-469)に `kind:"image"` 分岐。画像は data URI 埋め込み `<image>`
  (前例: renderRotatedPanelImageLayer L648-678)。**asset 読み込みが async のため、事前に assetId→dataURI
  マップを解決してから同期レンダリングに渡す**(renderObjectsLayer 自体の async 化でも可)。
- clipPanelId があればコマ形状の clipPath を defs に出し、**外側 g=clip / 内側 image=rotate の二層**
  (renderAssignmentImage L224-231 と同じ理由: 同一要素だと clip も回る)。
- 回転は既存規約(pixel 空間の剛体回転)に合わせる。Mosaic が最後である順序は崩さない。
- 注意: L241-246/L252-254 の `layers.length === 0` 分岐は到達不能のデッドコード(誤読しないこと)。

### クライアント(lightbox objects モード)
- `renderPageObjectShape`(pagePanelLightboxView.ts:636-644)に image 分岐。ヒットは
  「透明外接矩形 `fill="transparent"`(`"none"` 禁止)+表示要素 pointer-events:none」パターン踏襲。
  `<image href>` は renderAssignmentImage が前例(escapeAttr、preserveAspectRatio="none")。
- objects ステージ(renderObjectsStageContent:624-634)は現状 paper のみ描画 → **コマ画像+コマ枠を非活性
  背景(pointer-events:none)として描き、back 帯 image → 枠 → front 帯の順に描く**。defs(clipPath)追加が必要。
- ギズモ: gizmoBoxForPageObject は box と同じ分岐(size ベース)。beginObjectDrag の startObject コピー、
  scale 分岐(853-864 の box と同型)、editableObjectUnchanged に image を追加。
- ツールバー(renderObjectsToolbar:772-805): 「画像追加」ボタン → PageDetail.assets(lightbox open 時取得済み)
  からのピッカー。選択オブジェクトのプロパティ行に band トグル(枠の後ろ/前)・opacity スライダー・
  クリップ先コマ選択(ページの layout.panels から)・アセット差し替え。
- getStageTransform は回転していない要素から取る制約(svgGizmo.ts:33-38)— ImageObject 自身の g から CTM を取らない。
- scale(1000) group の外に描かない(不可視になる既知の罠)。

### 受け入れ条件
- 画像オブジェクトを追加・移動・拡縮・回転・帯切替・クリップ切替でき、保存往復(1s debounce PATCH)で
  フィールドが消えない。
- preview.png / ORA / PNG 一括書き出しの 3 経路すべてで帯順が反映される(ORA は Objects (back) レイヤーが増える)。
- imageExportModal.ts:53 の平坦化順説明文を更新。

---

## S3: 脚本ドメイン(Character / MangaScript / DialogueLine)+ Fountain パーサ

### 目的
物語データを一級市民にする。Fountain 取り込み → キャラクタ管理 → セリフ一覧 → **手動配置を先に完成**させる
(S4 の LLM 提案はこの上に乗る)。

### DB(db.ts の CREATE ブロック末尾へ追記 + 索引)
```sql
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,                    -- createId("char")
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,                      -- string[](Fountain 話者名の別表記)
  notes TEXT NOT NULL DEFAULT '',         -- 口調・関係性メモ(S4 で LLM へ渡す)
  color TEXT,                             -- UI 識別色 #rrggbb
  face_image_path TEXT,                   -- 顔参照画像(reference ストレージ流用)
  lora_name TEXT,                         -- 絵柄/キャラ LoRA(Comfy choice verbatim)
  lora_strength REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS manga_scripts (
  id TEXT PRIMARY KEY,                    -- createId("script")
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  fountain_source TEXT NOT NULL,
  parsed_json TEXT NOT NULL,              -- FountainDoc(下記)
  revision INTEGER NOT NULL DEFAULT 1,    -- source 更新ごとに +1(S4 提案の鮮度判定に使う)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dialogue_lines (
  id TEXT PRIMARY KEY,                    -- createId("line")
  project_id TEXT NOT NULL,
  script_id TEXT,                         -- 手動追加行は NULL
  character_id TEXT,
  speaker_label TEXT NOT NULL DEFAULT '', -- Fountain 上の生の話者表記
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dialogue',  -- dialogue | monologue | narration | sfx
  emotion TEXT,
  order_index INTEGER NOT NULL DEFAULT 0, -- 脚本内の出現順(シーン跨ぎ通し番号)
  scene_index INTEGER,                    -- 何シーン目か(0 始まり)
  page_id TEXT,                           -- 配置先ページ(未割当 NULL)
  panel_id TEXT,                          -- 配置先コマ(layout.panels の JSON id、FK 不可)
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | placed
  balloon_object_id TEXT,                 -- 配置した吹き出し PageObject の id
  source TEXT NOT NULL DEFAULT 'fountain',-- fountain | manual | llm
  proposal_id TEXT,                       -- S4: 採用元提案
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
);
```
- jsonColumnNames へ `aliases_json→aliases`、`parsed_json→parsed` を登録(グローバルマップなので既存名と
  意味衝突しないこと)。
- panel_id は rounds.ts:152-163 と同じ「layout.panels に実在する id のみ許可」検証。ページのレイアウト
  変更/コマ削除時は pages.ts の updatePageLayout/deletePage に後始末(該当行の panel_id/status リセット)を追記。
- characters はプロジェクト所属(assets/pages と同じ前例)。作品横断キャラは将来課題。

### Fountain パーサ(src/shared/fountain.ts、純ロジック+テスト)
外部依存なしのサブセット実装。対応要素:
- Title Page(`Key: Value` 連続行)/ Scene Heading(INT./EXT./EST. 等 + 強制 `.`)/ Action /
  Character cue(**大文字行** + 強制 `@`)/ Parenthetical `()` / Dialogue / Dual dialogue `^` は単一化 /
  Transition(`>` / `TO:`)/ Section `#` / Synopsis `=` / Note `[[ ]]`(保持)/ Boneyard `/* */`(除去)
- **日本語対応が本命**: 日本語名は大文字判定が効かないため、強制 `@キャラ名` を正とし、ドキュメントと
  UI プレースホルダで案内する。`@` 無しの日本語話者行は「次行が空行でない非 heading 行」なら character cue と
  みなす寛容モード(誤検出は Action へフォールバック)。パーサは fail-loud ではなく警告リストを返す
  (`{ doc, warnings: string[] }`)— 脚本データは黙殺せず警告表示(既存 normalize の黙殺方針とは意図的に変える)。

```ts
interface FountainDoc {
  titlePage: Record<string, string>;
  scenes: Array<{
    heading: string;                       // 空文字 = 冒頭の無シーン部
    elements: Array<
      | { type: "action"; text: string }
      | { type: "dialogue"; speaker: string; parenthetical?: string; text: string }
      | { type: "transition"; text: string }
      | { type: "section"; depth: number; text: string }
      | { type: "synopsis"; text: string }
    >;
  }>;
}
```

### 取り込みフロー(サーバ)
`POST /api/projects/:id/scripts` { title?, fountainSource } →
1. `parseFountain` → parsed_json 保存
2. 話者名を正規化(trim、`@` 除去)し、既存 characters の name/aliases と突合。未知話者は characters を自動作成
3. dialogue 要素を dialogue_lines へ展開(order_index 通し、scene_index、kind は既定 dialogue。
   parenthetical に (M)/(N) 等があれば monologue/narration へ、`SFX:` 接頭辞は sfx — 規約はパーサ内で判定)
`PUT /api/scripts/:id` { fountainSource } → 再パース、revision+1、**既存 dialogue_lines のうち
status='draft' かつ source='fountain' の行は作り直し、placed 行は保持**(配置済みを壊さない)。

### API
```
GET    /api/projects/:id/characters            一覧
POST   /api/projects/:id/characters            作成 { name, ... }
PATCH  /api/characters/:id                     更新(name/aliases/notes/color/faceImageDataUrl/lora)
DELETE /api/characters/:id
GET    /api/projects/:id/scripts               一覧(revision 含む)
POST   /api/projects/:id/scripts               取り込み(上記)
GET    /api/scripts/:id                        detail(parsed + lines)
PUT    /api/scripts/:id                        source 更新・再パース
DELETE /api/scripts/:id
GET    /api/projects/:id/dialogue-lines?pageId=&scriptId=   一覧
POST   /api/projects/:id/dialogue-lines        手動行追加
PATCH  /api/dialogue-lines/:id                 割当変更(pageId/panelId/characterId/text/kind/status/balloonObjectId)
DELETE /api/dialogue-lines/:id
```
ルートは index.ts の if 連鎖へ既存慣例どおり追記(`/pages/reorder` 型の順序衝突に注意)。検証は
validate.ts の coercer + shared 正規化。ドメインロジックは `src/server/scripts.ts` / `src/server/characters.ts` /
`src/server/dialogueLines.ts` に分離(pages.ts が手本)。

### UI
1. **脚本画面(Book レベルの新スクリーン)**: `state.scriptScreenOpen`(bookSettingsOpen: appState.ts:304-305 と
   同型)+ main.ts render 三項分岐 + bookView.ts 見出しアクションに「脚本」ボタン。新規 `scriptController.ts` +
   `views/scriptView.ts`。内容: Fountain テキストエリア(取り込み/更新)、パース警告表示、シーン/セリフ一覧
   (話者色付き)、キャラクタ一覧(name/色/口調メモ/顔参照画像/LoRA。顔参照は「最近使った画像」ピッカー
   generationPanel.ts:295-310 の前例を流用)、セリフ行のページ割当(ページ番号ドロップダウン)。
2. **配置(lightbox objects モードに「セリフ」ドロワー)**: 当該ページ割当済み・未配置の dialogue_lines を
   リスト表示 → 行をクリック → `createBalloonObject`(pageObjects.ts:386-400)を選択コマ中心
   (panelBounds/shapeCenter で算出)or ページ中央へ生成、`content.text` にセリフ、縦書き既定。
   `PageObjectBase` に `sourceDialogueLineId?: string` を追加し(**normalizeBase で保持**)、
   dialogue_lines 側にも balloon_object_id を PATCH(status='placed')。
   吹き出しサイズは computeTextLayoutForContent のサーバ計測 or 既定サイズ+ユーザー調整(v1 は既定サイズで可)。
3. 自動配置はユーザー編集との last-write-wins 競合を避けるため、**lightbox を開いている本人の操作としてのみ**
   実行する(バックグラウンド自動配置はしない)。

### 受け入れ条件
- 日本語 Fountain(@話者)を取り込むと characters と dialogue_lines が生成され、再取り込みで placed 行が保持される。
- セリフ行から吹き出しを 1 クリック配置でき、書き出し(ORA/PNG)に反映される。
- PAGE_OBJECTS_MAX_COUNT=300 超過時は配置を拒否しトースト警告(黙殺しない)。

---

## S4: 構造化 LLM セリフ提案(DialoguePlan)

### 目的
OpenAI 互換 LLM に「このページ(コマ構成・シーン文脈・キャラ口調)に合うセリフ案」を構造化 JSON で出させ、
採用すると dialogue_lines になる。**LLM の生出力・モデル名・脚本 revision・採用履歴を永続化**し、
物語制作の過程もツリー的に残す。

### 前提整備(llm.ts の改修)
- `LlmSettings` に `apiKey?: string` を追加(Authorization: Bearer 条件付与。設定フォームに password input)。
  クラウド互換エンドポイント対応の必須先行作業。
- `llmFetchJson` の欠陥修正: **response.ok 判定 → JSON.parse の順**に直し、abort 時は専用メッセージ。
  エラーボディは 500 文字程度に切り詰めてからメッセージ化。
- 汎用 `chatCompletion(settings, { messages, temperature?, responseFormat?, timeoutMs, signal? })` を export し、
  improvePromptWithLlm はその薄いラッパーへ。
- isLlmConfigured 相当の 3 箇所重複(llm.ts:13-15, main.ts:1060/1093, settingsController.ts:107)は
  apiKey 追加で条件が変わらない(baseUrl+model のまま)ことを確認しつつ、可能なら shared へ一本化。

### 構造化生成(src/server/llmStructured.ts)
```ts
async function generateStructuredJson<T>(opts: {
  settings: LlmSettings;
  systemPrompt: string;
  userPrompt: string;
  schema: object;                          // JSON Schema(response_format 用)
  validate: (raw: unknown) => T | null;    // 手書き検証(repo 慣例。zod は入れない)
  maxRetries?: number;                     // 既定 2
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ value: T; rawOutput: string }>
```
- 1 回目: `response_format: { type: "json_schema", json_schema: {...} }` を送る。
- 失敗(HTTP 4xx で response_format 非対応と推定 / パース不能 / validate null)時:
  response_format 無しでプロンプト誘導(「JSON のみを出力」+スキーマ提示)に切り替え、
  検証エラー内容を user メッセージに付けて再試行(最大 maxRetries)。
- コードフェンス除去(```json ... ```)と先頭/末尾ノイズ除去のベストエフォートパースを挟む。
- ローカル LLM サーバ(LM Studio / llama.cpp / Ollama 互換層)の response_format 対応はまちまちなので
  この二段構えを既定とする。

### DialoguePlan(DB)
```sql
CREATE TABLE IF NOT EXISTS dialogue_proposals (
  id TEXT PRIMARY KEY,                    -- createId("proposal")
  project_id TEXT NOT NULL,
  script_id TEXT,
  script_revision INTEGER,                -- 提案時点の manga_scripts.revision
  page_id TEXT,
  model TEXT NOT NULL,
  request_json TEXT NOT NULL,             -- 送信 messages(再現性)
  raw_output TEXT,                        -- LLM 生出力 verbatim
  parsed_json TEXT,                       -- 検証済み提案配列
  status TEXT NOT NULL DEFAULT 'proposed',-- proposed | adopted | rejected | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
);
```
jsonColumnNames へ `raw_output` は登録しない(生文字列のまま)。`request_json→request` は既存キーと同名衝突
… **既存 `request_json→request` が既にあるためそのまま流用可**(テーブル横断グローバルの仕様を逆手に取る)。

提案スキーマ(parsed_json):
```ts
type DialogueProposal = Array<{
  panelId: string | null;                 // レイアウトのコマ id(コマ無しページは null)
  speakerName: string;                    // characters.name との突合はサーバで character_id 解決
  text: string;
  kind: "dialogue" | "monologue" | "narration" | "sfx";
  emotion?: string;
}>;
```

### プロンプト構成(src/server/dialogueLlm.ts)
system: 「あなたは漫画のセリフ作家。出力は JSON のみ」+ スキーマ。
user: 脚本の該当シーン抜粋(scene_index からの周辺文脈)、ページのコマ数と読み順(layout.panels order)、
キャラクタ一覧(name / notes=口調 / aliases)、既存の placed 済みセリフ(重複回避)、指示(1コマ 1〜2 行、
sfx は擬音のみ等)。temperature は request パラメータで上書き可(既定は settings.temperature)。

### API / UI
```
POST /api/projects/:id/pages/:pageId/dialogue-proposals   { scriptId?, instruction? } → 提案生成(60s timeout)
GET  /api/projects/:id/dialogue-proposals?pageId=
POST /api/dialogue-proposals/:id/adopt                    { indices?: number[] } → dialogue_lines 作成(source='llm', proposal_id)
POST /api/dialogue-proposals/:id/reject
```
UI: S3 のセリフドロワー(lightbox)に「AI セリフ提案」ボタン(llmConfigured 時のみ表示、llmImproving と同型の
busy フラグ)。提案リスト → 行ごと/一括採用 → 以降は S3 の手動配置フローに合流。
**LLM 待ち中のページ移動ガード**(generationController.ts:291-316 と同じ activePageId 捕捉ガード)を必ず入れる。

### 受け入れ条件
- script_revision が現在の revision と異なる提案は UI で「脚本が更新されています」と警告表示。
- LLM 失敗時(接続不可/検証 3 回失敗)は proposals に status='failed' で記録され、トーストにエラー要約。
- 生出力(raw_output)が DB に残り、採用行から proposal_id で遡れる。

---

## 実装順・ブランチ運用

| 順 | ブランチ | 内容 | 主な受け入れ検証 |
|---|---|---|---|
| S1 | `s1-generation-provider` | Intent/Provider 抽象化 | 既存テスト緑 + ヘッドレス生成スモーク(source-asset) |
| S2 | `s2-image-object` | ImageObject + 帯 | 3 書き出し経路 + 保存往復 |
| S3 | `s3-script-domain` | 脚本ドメイン + Fountain + 手動配置 | パーサ単体テスト + 取り込み→配置 E2E |
| S4 | `s4-dialogue-llm` | 構造化 LLM 提案 | 構造化生成の検証/リトライ単体テスト |

- 各ブランチは worktree で作業し、レビュー(正しさ/スキーマ・マイグレーション安全性/リポジトリ慣例)→修正→
  main へマージ。マージ後に `bun run typecheck` / `bun test` / `bun run check`。
- S2 以降は直前フェーズマージ後の main から分岐(apiTypes.ts / db.ts / index.ts の競合回避)。

## 既知の罠(実装者向けチェックリスト)
1. shared normalize は未知 kind/フィールドを黙って捨てる → 新フィールドは normalize 更新とセットで。
2. jsonColumnNames 登録漏れ → API に生 JSON 文字列が出る(エラーにならない)。
3. SQLite ALTER ADD COLUMN は NOT NULL に定数 DEFAULT 必須。DEFAULT なし NOT NULL はゴミ箱復元も壊す。
4. SVG: scale(1000) g の外は不可視 / fill="none" はヒットしない(transparent を使う)。
5. registerActions の名前重複は起動時 throw。
6. 非同期完了後の state 書き込みは activePageId/currentProjectId 捕捉ガード必須。
7. モーダル backdrop 判定は if/else 順序依存(main.ts:221-238)。regions 配列への追加漏れは無音バグ。
8. `bun run check` は typecheck/test を含まない。3 点セットを回すこと。
9. テストは node:test + node:assert/strict、相対 import は .ts 拡張子明示。
10. main.ts への関数追加は禁止(AGENTS.md)。専用 controller + registerActions/registerEventBinder。
