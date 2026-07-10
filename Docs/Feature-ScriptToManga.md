# Feature: Script-to-Manga 下地(S1〜S4)

最終目標: **Fountain 脚本を入力すると、guruguru が自動でコマ割りを行い、各コマに適した画像生成を行い、セリフも自動生成して漫画ページを完成させる。**

本ドキュメントはその下地となる 4 つのサブプロジェクト(S1〜S4)の設計書。将来の画像生成モデルの進化
(ページ一発生成・透過出力・外部 API 型モデル等)に「全体改修」ではなく「アダプタ追加」で追随できる構造と、
コマをまたぐ表現(立ち絵ぶち抜き)・セリフ自動生成のためのドメインモデルを整える。

- ステータス: S1 実装済み(レビュー反映中)。S2〜S4 未着手。
  ブランチ: `s1-generation-provider` / `s2-image-object` / `s3-script-domain` / `s4-dialogue-llm`(順に main へマージ)
- 前提調査: 2026-07-10 に生成経路/DB/ページオブジェクト/書き出し/Book UI/LLM/API 慣例の 7 領域を精査済み。本文中の行番号はその時点のもの。

## 改訂履歴
- **v2 (2026-07-10)**: 第三者設計レビューを反映。採用: Comfy 固有 DB 列の再解釈をやめレガシー宣言+汎用列追加 /
  Intent からローカルパスを排除し `ArtifactRef` 化 / `target` を判別共用体化 / 中立 `task`・`recipe` の導入 /
  capabilities を recipe 単位で解決 / `output.alpha` 三値化・seed 能力表現 / providerOptions の規律 /
  FakeProvider 契約テスト / ImageObject の Asset 寿命問題を page_media コピー方式で解決 /
  script revision の不変保存 / DialogueLine と DialoguePlacement の分離(1対多) / semanticKind と renderKind の分離 /
  Character の Provider 別 AppearanceBinding 分離 / 提案の項目別採用履歴。
  見送り(理由付き): ジョブ単位 native_request_json/native_result_json 列(サイズ重複が大きく、外部 Provider
  実需要まで保留。ジョブには provider_job_ref のみ追加)/ Asset への model_id/model_revision 列(モデル情報は
  round の capability snapshot に含める。assets.model_name 既存列で十分)/ layoutRevision(レイアウトに
  リビジョン機構が無いため将来課題。CompositionSpec と併せて F4 で導入)/ getStatus 中心のポーリング再配線
  (collect が事実上のポーリングフォールバックとして既に機能。IF には getStatus を置き、実装は薄く)。

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
| ComfyUI 内の新チェックポイント/標準ワークフロー | テンプレ+role map 追加(現状でも可) | S1 で recipe 単位 capability snapshot が付く |
| ComfyUI 内の独自ノード・独自制御 | ComfyProvider の patch/能力判定を拡張 | S1 |
| 外部 API・別実行基盤 | Provider を1個追加(rounds/UI は不変) | S1 |
| 透過出力できるモデル | `capabilities.alpha` → ImageObject へ直行 | S1+S2 |
| ページ一発生成モデル | `capabilities.pageGeneration` → pageComposite 対象 Intent + CompositionSpec | S1(F4 で接続) |
| 文字も描けるモデル | **使わない**。文字は guruguru が吹き出しとして描く | S3/S4 の方針 |

セリフは画像モデルに描かせない。縦書き・fontkit グリフパス・吹き出し・書き出しを既にアプリ側で制御できて
いるため、AI は「台詞案(構造化データ)」を返し guruguru が配置する。文字化けせず、後編集・翻訳・フォント
変更に強い。

将来フェーズ(本下地の範囲外、下地が前提):
- **F1 自動コマ割り**: 脚本のシーン/拍数から layout_templates を LLM が選定・調整
- **F2 コマ別 Intent 合成**: シーン記述+Character の AppearanceBinding(顔参照/LoRA)から各コマの GenerationIntent を自動構築
- **F3 前景立ち絵パイプライン**: 透過出力モデル or 既存 webSAM(`src/client/websam/`)切り抜きで ImageObject を量産
- **F4 ページ一発生成**: pageGeneration 能力を持つ Provider へ `target: pageComposite` + `CompositionSpec`
  (生成時点のコマ形状・順序・ページ比率のスナップショット)を投げ、結果をページへ

---

## S1: GenerationIntent / GenerationProvider 抽象化

### 目的
「何を作りたいか(Intent)」と「そのモデルでどう実行するか(Provider)」を分離する。最初の実装は既存
ComfyUI 実行を包む ComfyProvider のみ。**HTTP API(POST /rounds、collect、interrupt)とクライアントは無改修。**

### 実装状況メモ(**S1 完了 — 2026-07-10 main マージ済み、merge commit 183bb6b**)
v2 修正一覧 7 項目+レビュー確定指摘 5 件(critical の manual ラウンド削除不能を含む)をすべて反映済み。
providers/{types,registry,comfyProvider,fakeProvider}.ts、shared/generationIntent.ts(v2 形)、
roundAttachments.ts、rounds.ts の Provider 経由化、generation_jobs.provider_job_ref。559 テスト緑。
実装判断のうちレビュー未確定なのは「ipadapter モードの親画像 → identity へ写像」(resolveIdentity の
JSDoc に経緯記載)。ComfyProvider.submit は確定判断どおり GenerationRequest 駆動のまま
(ctx.intent は受け取るが未消費)。

実装上の確定判断(v1 で妥当と確認済み):
- `GenerationRequest` はクライアント wire 型 兼 Comfy 実行時の詳細パラメータとして温存。GenerationIntent は
  「中立な記録・将来 Provider の入力」という並行成果物(Intent→Request の逆変換はしない)。
- collectLegacyRound / interruptLegacyRound(jobs 行なしの旧ラウンド)は現状維持+TODO コメント。
- submit はラウンド一括呼び出し(jobs 行は submit 完了時にまとめて確定)。

### パイプライン順序(正)
```
HTTP Request → normalize → 添付を永続化(prepare*: dataUrl→ファイル)
  → GenerationIntent 構築(ArtifactRef 参照、ローカルパスなし)→ INSERT(intent_json)
  → resolveIntentArtifacts()(サーバ専用: ArtifactRef→絶対パス解決 = PreparedGenerationIntent)
  → provider.submit(prepared, jobs)
```
`toGenerationIntent` は **prepare* 完了後**に呼ぶ(inpaint/ControlNet/参照画像が Intent から落ちない)。

### GenerationIntent v2(モデル中立語彙・永続可能)
```ts
/** 永続可能な成果物参照。共有 Intent にローカルファイルパスを置かない。 */
type ArtifactRef =
  | { kind: "asset"; assetId: string }
  | { kind: "roundAttachment"; roundId: string; attachment: "mask" | "pose" | "reference" | "composite" }
  | { kind: "pageMedia"; mediaId: string };   // S2 で導入(前景画像等)

/** 出力の割り当て先(構図情報ではない。構図は F4 の CompositionSpec)。 */
type GenerationTarget =
  | { kind: "project" }                                  // single モードの従来生成
  | { kind: "page"; pageId: string }                     // Book ページ所属の生成
  | { kind: "panel"; pageId: string; panelId: string }   // コマ内生成
  | { kind: "pageComposite"; pageId: string };           // F4 予約(ページ一発生成)。S1 では構築しない

interface GenerationIntent {
  version: 2;
  /** 中立な操作種別。provider はこれと入力の有無で実行内容を決める。 */
  task: "create" | "transform" | "inpaint" | "upscale" | "detail";
  /** 実行レシピ(Comfy では recipeId = workflow_templates.id、revision = String(version))。 */
  recipe: { providerId: string; recipeId: string; revision?: string };
  prompt: { positive: string; negative: string };
  canvas: { width: number; height: number };
  batchCount: number;                     // 1..32(独立ジョブ N 個)
  seed: { mode: "fixed" | "random" | "increment" | "reuse_parent"; value: number | null };
  source?: { image: ArtifactRef; denoise: number } | null;   // transform/inpaint/upscale/detail の入力
  inpaint?: { mask: ArtifactRef; maskedContent: MaskedContent; padding: number; feather: number } | null;
  control?: Array<{ kind: "pose" | "edge"; image: ArtifactRef; strength: number; range: [number, number] }>;
  identity?: { face: ArtifactRef } | null;                   // 人物同一性参照(現実装は PuLID)
  styles?: Array<{ id: string; strength: number }>;          // id は provider スコープの不透明文字列
  output?: { alpha: "none" | "preferred" | "required" };     // 既定 "none"
  target: GenerationTarget;
  /** 助言的サンプリングパラメータ。provider は解釈可能な範囲で使い、無視してよい。 */
  sampling?: { steps?: number; cfg?: number; sampler?: string; scheduler?: string };
  /** provider 固有のエスケープハッチ(下記の規律に従う)。 */
  providerOptions?: Record<string, unknown>;
}
```
task の導出(generationMode から): txt2img/seed_reuse/prompt_reuse → create、img2img は inpaint 有り→inpaint /
無し→transform、ipadapter/controlnet → transform(control/identity の有無で表現)、upscale → upscale、
detail → detail。manual_upload は Provider を通らない(provider_id='manual')。

**providerOptions の規律(必須)**:
- 汎用オーケストレータ(rounds.ts)は中身を一切読まない。
- Provider ごとに検証・正規化してから永続化する(comfy: { generationMode, templateId } のみ許可、未知キーは落とす)。
- API キー・署名付き URL・ローカルファイルパスの格納は禁止(秘密は app_settings へ)。

`PreparedGenerationIntent`(src/server/providers/types.ts、**shared に置かない**)は同形で ArtifactRef が
絶対パスに解決されたもの。解決は `resolveIntentArtifacts(intent)`(server 専用ヘルパ)。asset→assets.image_path、
roundAttachment→request_json のパス(serveRoundAttachment と同じ解決)、pageMedia→page_media.file_path。

### ProviderCapabilities(recipe 単位で解決)
能力は Provider 固定ではなく「選択された recipe・接続状態」で変わる。`resolveCapabilities(recipe)` で解決し、
結果をラウンドへスナップショット保存する。
```ts
interface ProviderCapabilities {
  providerId: string;
  providerVersion?: string;               // Provider 実装/接続先のバージョン情報(取得できる範囲で)
  displayName: string;
  modelFamily: string;                    // 例 "chroma"
  features: {
    transform: boolean | null; inpaint: boolean | null;
    controlPose: boolean | null; controlEdge: boolean | null;
    identityReference: boolean | null; styles: boolean | null;
    pageGeneration: boolean | null;
  };                                      // null = 未確認(接続不能等)
  alpha: "none" | "native" | "postprocess";   // 透過出力の提供方法
  seed: "reproducible" | "bestEffort" | "unsupported";
  checkedAt: string;
}
```

### GenerationProvider IF(v2)
```ts
interface GenerationProvider {
  readonly id: string;
  resolveCapabilities(recipe: { recipeId: string; revision?: string }): Promise<ProviderCapabilities>;
  /** Intent がこの provider/recipe で実行可能かの事前検証。 */
  validateIntent(intent: GenerationIntent): Promise<{ ok: boolean; issues: string[] }>;
  /** batchCount 個のネイティブジョブを投入。jobRef は不透明文字列。 */
  submit(ctx: ProviderSubmitContext /* prepared intent + per-job seeds + jobs */): Promise<ProviderSubmittedJob[]>;
  /** ポーリングフォールバック(watch が張れない/切れた場合の状態確認)。 */
  getStatus(jobRef: string): Promise<"pending" | "running" | "completed" | "failed" | "unknown">;
  /** jobRef の成果画像を取得(未完なら空配列)。これ自体もポーリングとして機能する。 */
  collectImages(jobRef: string, ctx: ProviderCollectContext): Promise<ProviderCollectedImage[]>;
  interrupt(jobRefs: string[]): Promise<ProviderInterruptResult>;
  /** 進捗監視(最適化。必須ではない。Comfy: WebSocket)。 */
  watchProgress?(ctx: ProviderWatchContext): void;
}
```
- `watch` は最適化であり、`collectImages`(+`getStatus`)によるポーリングを必須のフォールバックとする
  (現行もクライアント 3 秒ポーリング → collect が WS 無しで完走できる設計。これを維持)。
- サーバ再起動後の復旧: jobs 行の provider_job_ref から collect/watch を再開できること(現行の
  ensureRoundMonitor 再確立と同じ)。FakeProvider 契約テストで検証する。

### DB(v2 方針: **Comfy 固有列は再解釈せずレガシー宣言**)
- **レガシー列(ComfyProvider だけが書く。他 Provider は触らない)**: `generation_rounds.prompt_id`、
  `generation_rounds.patched_workflow_json`、`generation_jobs.prompt_id`、`generation_jobs.client_id`、
  `assets.comfy_output_node_id`。db.ts の型コメントにレガシー宣言を明記。
- **汎用列(ensureColumn 追記)**:
```
generation_rounds.provider_id            TEXT NOT NULL DEFAULT 'comfy'   … v1 実装済み
generation_rounds.intent_json            TEXT                            … v1 実装済み(v2 形式へ更新)
generation_rounds.provider_snapshot_json TEXT                            … v1 実装済み(recipe 単位解決の結果)
generation_jobs.provider_job_ref         TEXT                            … v2 追加。comfy は prompt_id と同値を二重書き
```
- オーケストレータ(rounds.ts)は `provider_job_ref ?? prompt_id` を読む(旧データ互換)。
- ジョブ単位の native_request_json/native_result_json は**追加しない**(先頭ジョブの nativeSubmission を
  patched_workflow_json に保存する従来動作を Comfy レガシーとして維持。外部 Provider 追加時に必要になったら
  その時に汎用列を足す — ensureColumn 1 行で済む)。
- jsonColumnNames へ intent_json→intent, provider_snapshot_json→providerSnapshot(v1 済み)。
- intent_json にローカルパス・dataUrl・秘密を含めない(ArtifactRef 化で保証)。

### 契約テスト(FakeProvider)
- `src/server/providers/fakeProvider.ts`(テスト専用可): インメモリのジョブストアを持ち、
  submit/getStatus/collectImages/interrupt と部分失敗(N 番目のジョブだけ fail 等)をプログラム可能にする。
- registry へテスト時のみ登録し、`createGenerationRound` に **request.providerId(省略時 'comfy'、
  クライアントは送らない)** を通して選択。契約テスト項目:
  1. submit → collect で assets が作られ、seed・ツリー(asset_parents)・provider_job_ref が正しい
  2. 部分失敗(1 ジョブ fail)でラウンドが正しい終端状態になる
  3. interrupt で running/queued の振り分けが正しい
  4. 「再起動相当」(モジュール内メモリを介さず DB の jobs 行だけから)collect が完走する
- 既存の Comfy 経路は rounds.test.ts の既存テスト+ヘッドレススモークで挙動同一性を担保。

### v2 修正一覧(v1 実装からの差分作業)
1. GenerationIntent を v2 形へ(ArtifactRef / task / recipe / target 判別共用体 / output.alpha)。テスト更新。
2. resolveIntentArtifacts + PreparedGenerationIntent を server 側に追加、comfyProvider.submit の入力を prepared に。
3. ProviderCapabilities を recipe 単位解決へ(resolveCapabilities(recipe))。alpha/seed の能力表現。
4. generation_jobs.provider_job_ref 追加+二重書き+読み側フォールバック。レガシー列コメント。
5. providerOptions の検証(comfyProvider 内で正規化、未知キー除去)。
6. FakeProvider + 契約テスト + request.providerId(隠しフック)。
7. getStatus の追加(comfy: history 有→completed / queue 照合→running/pending / 不明→unknown の薄い実装)。

---

## S2: ImageObject + レイヤー帯(コマぶち抜き立ち絵の土台)

### 実装状況メモ(**S2 完了 — 2026-07-10 main マージ済み、merge commit 757ae18**)
本セクションの要求はすべて実装済み(page_media+コピーAPI+配信、ImageObject 型+全フィールド保持
normalize、帯順 3 経路共通、ORA "Objects (back)" レイヤー、clip 二層、objects モードの非活性コマ背景+
ピッカー+プロパティ行、欠損時プレースホルダ/スキップ+警告)。575 テスト緑(+16)。
設計に無かった追加: `PageDetail.missingPageMediaIds`(編集画面のプレースホルダ判定用の明示 API フィールド)。
クライアント表示は data URI でなく `GET /api/page-media/:id` 参照(renderAssignmentImage の前例踏襲。
data URI 化はサーバ書き出しの sharp ラスタライズのみ)。

### 目的
ページオブジェクトに「画像」を追加し、**コマ枠より後ろ/前**のレイヤー帯を導入する。これで
「コマ背景 → 枠の後ろの前景人物 → コマ枠 → 枠より前の人物 → 吹き出し・文字 → モザイク」の合成ができる。

### Asset 寿命問題と page_media(v2 で確定)
`pages.objects_json` 内の JSON は assets への FK を持てず、Round 削除で Asset が cascade 消滅すると
`assetId` だけが残る孤児が生じる。**解決: 配置時にファイルを page 所有メディアへコピーする。**
```sql
CREATE TABLE IF NOT EXISTS page_media (
  id TEXT PRIMARY KEY,                    -- createId("media")
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,                -- projects/<id>/page_media/ 配下へコピー
  width INTEGER, height INTEGER,
  source_asset_id TEXT,                   -- 来歴(元 Round が消えたら SET NULL)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_asset_id) REFERENCES assets(id) ON DELETE SET NULL
);
```
- ImageObject は `mediaId` を参照(assetId 直接参照はしない)。Round/Asset 削除でページ作画は壊れない。
  来歴(どの生成から来たか)は source_asset_id で追える(創作過程の保持)。
- それでも file 欠損・media 行欠損が起きた場合の挙動を定義: 編集画面はプレースホルダ(破線枠+ media id)表示、
  書き出しはそのオブジェクトをスキップして警告ログ。**黙って落とさない。**
- 参照されなくなった page_media の GC は将来課題(ストレージ逼迫時に「未参照メディア掃除」を別途)。
- 配信: `GET /api/page-media/:id`(streamFile、serveRoundAttachment と同型の isPathInside ガード)。

### 型(src/shared/pageObjects.ts:95 の union へ追加)
```ts
export type ImageObjectBand = "back" | "front";   // back=コマ枠より後ろ(コマ画像より前)、front=枠より前(既定)

export interface ImageObject extends PageObjectBase {
  kind: "image";
  mediaId: string;                        // page_media.id
  size: PageVec;                          // page 単位。追加時はメディアのアスペクト比で初期化
  opacity?: number;                       // 0..1、既定 1
  band?: ImageObjectBand;                 // 既定 "front"
  clipPanelId?: string | null;            // コマ形状でクリップ。null/省略 = ぶち抜き
}
```
- `normalizeImageObject` は**全フィールドを保持**(正規化往復で消えると保存 1 秒後に編集が巻き戻る)。
- text/balloon/box は従来どおり常に front 帯(型変更なし)。帯内の重なりは配列順(先頭=背面)。
  任意の全体 zIndex は導入しない(枠・吹き出しの規則を壊さないため。帯 + 帯内配列順で固定)。

### 描画順(正・全経路共通)
```
Paper → コマ画像(order昇順) → [image back 帯] → コマ枠(Panels)
     → [front 帯: image + text/balloon/box、配列順] → Mosaic(最前面)
```

### サーバ書き出し(src/server/openRasterExport.ts)
- `createPageLayers`(L208-260): `appendObjectsLayer` を帯フィルタ付きで 2 回に分割。back 帯はコマ画像
  (L228-239)の後・`renderPanelFrameLayer`(L248-251)の前、front 帯は現行位置。レイヤー名は
  `"Objects (back)"` / `"Objects"`。レイアウト無し分岐(L211-223)も同様。
- `renderPageObjectElement`(L461-469)に `kind:"image"` 分岐。画像は data URI 埋め込み `<image>`
  (前例: renderRotatedPanelImageLayer L648-678)。**asset 読み込みが async のため、事前に mediaId→dataURI
  マップを解決してから同期レンダリングに渡す**(renderObjectsLayer 自体の async 化でも可)。
- clipPanelId があればコマ形状の clipPath を defs に出し、**外側 g=clip / 内側 image=rotate の二層**
  (renderAssignmentImage L224-231 と同じ理由)。
- 回転は既存規約(pixel 空間の剛体回転)に合わせる。Mosaic が最後である順序は崩さない。
- 注意: L241-246/L252-254 の `layers.length === 0` 分岐は到達不能のデッドコード(誤読しないこと)。

### クライアント(lightbox objects モード = コンポジット編集表示)
**受け入れ条件に含む**: objects モードのステージにコマ画像+コマ枠を非活性背景(pointer-events:none)として
描画し、back 帯 image → 枠 → front 帯の順で重ねる。ぶち抜き位置を見ながら編集できること。
- `renderPageObjectShape`(pagePanelLightboxView.ts:636-644)に image 分岐。ヒットは
  「透明外接矩形 `fill="transparent"`(`"none"` 禁止)+表示要素 pointer-events:none」パターン踏襲。
  `<image href>` は renderAssignmentImage が前例(escapeAttr、preserveAspectRatio="none")。
- objects ステージ(renderObjectsStageContent:624-634)に defs(clipPath)追加が必要。
- ギズモ: gizmoBoxForPageObject は box と同じ分岐(size ベース)。beginObjectDrag の startObject コピー、
  scale 分岐、editableObjectUnchanged に image を追加。
- ツールバー(renderObjectsToolbar:772-805): 「画像追加」→ PageDetail.assets からのピッカー
  (選択時にサーバへ POST /api/projects/:id/page-media { assetId } → mediaId 取得 → オブジェクト追加)。
  プロパティ行に band トグル・opacity スライダー・クリップ先コマ選択・メディア差し替え。
- getStageTransform は回転していない要素から取る制約 — ImageObject 自身の g から CTM を取らない。
- scale(1000) group の外に描かない(不可視の既知罠)。

### 受け入れ条件
- 画像オブジェクトの追加・移動・拡縮・回転・帯切替・クリップ切替・不透明度が動き、保存往復で消えない。
- preview.png / ORA / PNG 一括書き出しの 3 経路で帯順が一致(ORA は Objects (back) レイヤーが増える)。
- 元 Round 削除→ゴミ箱復元を跨いでも ImageObject が壊れない(page_media 方式の検証)。
  file/media 欠損時の挙動(プレースホルダ/スキップ+警告)がテストされている。
- objects モードでコマ背景・枠・人物を同時表示しながら編集できる。
- imageExportModal.ts:53 の平坦化順説明文を更新。

---

## S3: 脚本ドメイン(Character / MangaScript / DialogueLine / DialoguePlacement)+ Fountain パーサ

### 実装状況メモ(**S3 完了 — 2026-07-10 main マージ済み、merge commit e644c34**)
本セクションの要求はすべて実装済み(6テーブル、Fountain パーサ+日本語寛容モード、source_hash 差分照合、
API 一式、脚本画面、セリフドロワー、panel 削除時の placement NULL 化)。608 テスト緑(+33)。
実装判断(コード内コメントにも記載): binding の顔参照は dataUrl アップロード専用+API は
hasFaceImage/faceImageUrl のみ返す(生パス非露出)。「ページ割当」は中間状態を持たず placement 作成に統一
(dialogue_lines に page_id 列が無いため。ドロワーは全 active 行+「配置済み ×N」表示)。PUT binding は
フィールド単位の部分更新。`GET /api/scripts/:id/revisions`(一覧)をルート表へ追加。
手動セリフ行作成はサーバ実装+テスト済みだが専用 UI ボタンは未設置。

### 目的
物語データを一級市民にする。Fountain 取り込み → キャラクタ管理 → セリフ一覧 → **手動配置を先に完成**させる
(S4 の LLM 提案はこの上に乗る)。

### 設計原則(v2)
- **脚本原文と parse 結果は不変保存**(script_revisions)。再取り込みは新 revision の追加。
- **DialogueLine(物語上の台詞)と DialoguePlacement(ページ上の配置)を分離**。1 台詞を複数吹き出しへ
  分割できるよう 1 対多。
- **semanticKind(会話/心の声/ナレーション/SFX)と renderKind(吹き出し/字幕箱/自由文字)を分離**。
  semanticKind は台詞(Line)の属性、renderKind は配置(Placement)の属性。
- **Character 本体は Provider 中立**(name/aliases/notes/color)。顔参照や LoRA は Provider 別の
  AppearanceBinding として分離(将来の外部 Provider で別の参照形式を持てる)。

### DB
```sql
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,                    -- createId("char")
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,                      -- string[](Fountain 話者名の別表記)
  notes TEXT NOT NULL DEFAULT '',         -- 口調・関係性メモ(S4 で LLM へ渡す)
  color TEXT,                             -- UI 識別色 #rrggbb
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS character_bindings (
  id TEXT PRIMARY KEY,                    -- createId("bind")
  character_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,              -- 'comfy' 等
  binding_json TEXT NOT NULL,             -- comfy: { faceImagePath?, loraName?, loraStrength? }(provider が検証)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
-- UNIQUE(character_id, provider_id)

CREATE TABLE IF NOT EXISTS manga_scripts (
  id TEXT PRIMARY KEY,                    -- createId("script")
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS script_revisions (
  id TEXT PRIMARY KEY,                    -- createId("rev")
  script_id TEXT NOT NULL,
  revision INTEGER NOT NULL,              -- 1 始まり連番
  fountain_source TEXT NOT NULL,          -- 不変
  parsed_json TEXT NOT NULL,              -- 不変(FountainDoc)
  warnings_json TEXT,                     -- パーサ警告
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE CASCADE
);
-- UNIQUE(script_id, revision)

CREATE TABLE IF NOT EXISTS dialogue_lines (
  id TEXT PRIMARY KEY,                    -- createId("line")
  project_id TEXT NOT NULL,
  script_id TEXT,                         -- 手動追加行は NULL
  character_id TEXT,
  speaker_label TEXT NOT NULL DEFAULT '', -- Fountain 上の生の話者表記
  text TEXT NOT NULL,
  semantic_kind TEXT NOT NULL DEFAULT 'dialogue',  -- dialogue | monologue | narration | sfx
  emotion TEXT,
  order_index INTEGER NOT NULL DEFAULT 0, -- 脚本内の出現順(シーン跨ぎ通し番号)
  scene_index INTEGER,
  source_hash TEXT,                       -- 正規化(speaker+text)ハッシュ。再取り込みの差分照合キー
  status TEXT NOT NULL DEFAULT 'active',  -- active | orphaned(最新 revision に対応行が無い)
  source TEXT NOT NULL DEFAULT 'fountain',-- fountain | manual | llm
  proposal_id TEXT,                       -- S4: 採用元提案
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS dialogue_placements (
  id TEXT PRIMARY KEY,                    -- createId("place")
  line_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  panel_id TEXT,                          -- layout.panels の JSON id(FK 不可・実在検証)
  part_index INTEGER NOT NULL DEFAULT 0,  -- 台詞分割時の何番目か
  render_kind TEXT NOT NULL DEFAULT 'balloon',   -- balloon | caption | freeText
  balloon_object_id TEXT,                 -- 対応する PageObject の id(objects_json 内)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (line_id) REFERENCES dialogue_lines(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
```
- jsonColumnNames: `aliases_json→aliases`、`binding_json→binding`、`parsed_json→parsed`、`warnings_json→warnings`。
- panel_id は「layout.panels に実在する id のみ許可」検証(rounds.ts:152-163 の前例)。レイアウト変更/
  コマ削除時は pages.ts に後始末(該当 placement の panel_id を NULL 化)を追記。
- PageObjectBase に `sourceDialogueLineId?: string` を追加(**normalizeBase で保持**)し、吹き出し⇄台詞の
  双方向リンク(placement.balloon_object_id と対)。

### Fountain パーサ(src/shared/fountain.ts、純ロジック+テスト)
外部依存なしのサブセット実装。対応要素:
- Title Page(`Key: Value` 連続行)/ Scene Heading(INT./EXT./EST. + 強制 `.`)/ Action /
  Character cue(**大文字行** + 強制 `@`)/ Parenthetical `()` / Dialogue / Dual dialogue `^` は単一化 /
  Transition(`>` / `TO:`)/ Section `#` / Synopsis `=` / Note `[[ ]]`(保持)/ Boneyard `/* */`(除去)
- **日本語対応が本命**: 日本語名は大文字判定が効かないため、強制 `@キャラ名` を正とし、ドキュメントと
  UI プレースホルダで案内。`@` 無しの日本語話者行は「次行が空行でない非 heading 行」なら character cue と
  みなす寛容モード(誤検出は Action へフォールバック)。
- パーサは `{ doc, warnings: string[] }` を返し fail-loud 寄り(黙殺しない。警告は UI 表示+revision に保存)。

```ts
interface FountainDoc {
  titlePage: Record<string, string>;
  scenes: Array<{
    heading: string;
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

### 取り込み・再取り込みフロー(サーバ)
`POST /api/projects/:id/scripts` { title?, fountainSource } →
1. parseFountain → manga_scripts + script_revisions(rev=1) 保存
2. 話者名を正規化し characters の name/aliases と突合。未知話者は自動作成
3. dialogue 要素を dialogue_lines へ展開(order_index/scene_index/source_hash。
   parenthetical (M)/(N) → monologue/narration、`SFX:` 接頭辞 → sfx)

`POST /api/scripts/:id/revisions` { fountainSource } →(再取り込み。**全削除はしない**)
1. 新 revision を不変追加
2. **source_hash で差分照合**: 一致する既存行 → order_index/scene_index を更新して維持(配置も無傷)。
   新規行 → 追加。最新 revision に対応が無い既存行 → status='orphaned'(配置があれば UI で警告表示。
   自動削除しない)。orphaned 行の復活(後の revision で同 hash 再出現)は active へ戻す。

### API
```
GET/POST      /api/projects/:id/characters      PATCH/DELETE /api/characters/:id
GET/PUT       /api/characters/:id/bindings/:providerId      (binding_json は provider が検証)
GET/POST      /api/projects/:id/scripts         GET/DELETE   /api/scripts/:id
POST          /api/scripts/:id/revisions        GET          /api/scripts/:id/revisions/:rev
GET           /api/projects/:id/dialogue-lines?pageId=&scriptId=&status=
POST          /api/projects/:id/dialogue-lines  PATCH/DELETE /api/dialogue-lines/:id
POST          /api/dialogue-lines/:id/placements     { pageId, panelId?, renderKind? } → 吹き出し生成と対で作成
PATCH/DELETE  /api/dialogue-placements/:id
```
ドメインロジックは `src/server/scripts.ts` / `characters.ts` / `dialogueLines.ts` に分離(pages.ts が手本)。
ルートは index.ts の if 連鎖へ既存慣例どおり追記(`/pages/reorder` 型の順序衝突に注意)。

### UI
1. **脚本画面(Book レベルの新スクリーン)**: `state.scriptScreenOpen`(bookSettingsOpen と同型)+
   main.ts render 三項分岐 + bookView.ts 見出しアクションに「脚本」ボタン。新規 `scriptController.ts` +
   `views/scriptView.ts`。内容: Fountain テキストエリア(取り込み/再取り込み)、パース警告、シーン/セリフ一覧
   (話者色付き、orphaned はグレー+警告アイコン)、キャラクタ一覧(name/色/口調メモ + comfy binding:
   顔参照画像は「最近使った画像」ピッカー流用、LoRA 選択は styleLoraController 流用)、セリフ行のページ割当。
2. **配置(lightbox objects モードに「セリフ」ドロワー)**: 当該ページ割当済み・未配置の行をリスト表示 →
   行クリック → placement 作成+`createBalloonObject`(コマ中心 or ページ中央、`sourceDialogueLineId` 付与、
   縦書き既定)。renderKind=caption は BoxObject、freeText は TextObject で生成。
   吹き出しサイズは v1 は既定サイズ+ユーザー調整(将来 computeTextLayoutForContent で自動)。
3. 自動配置はユーザー編集との last-write-wins 競合を避けるため、**lightbox を開いている本人の操作としてのみ**実行。

### 受け入れ条件
- 日本語 Fountain(@話者)取り込みで characters/dialogue_lines が生成され、**再取り込みで変更/削除/移動した
  行が維持・orphaned 追跡される**(placement は無傷)。
- セリフ行から吹き出しを 1 クリック配置(1 台詞を 2 吹き出しに分割配置も可能)、書き出しに反映。
- PAGE_OBJECTS_MAX_COUNT=300 超過時は配置を拒否しトースト警告。
- パーサ単体テスト(日本語 @cue / 寛容モード / 警告 / boneyard / dual dialogue 等)。

---

## S4: 構造化 LLM セリフ提案(DialogueProvider)

### 実装状況メモ(**S4 完了 — 2026-07-10 main マージ済み、merge commit f6f27d8。これで S1〜S4 全フェーズ完了**)
本セクションの要求はすべて実装済み(llm.ts 改修+LlmHttpError/リトライ分類、llmStructured の
json_schema→プロンプト誘導フォールバック、DialogueProvider+prompt 分離、dialogue_proposals+項目別採用履歴、
adopt/reject API、AIセリフ提案 UI+ページ移動ガード+stale/failed バッジ)。631 テスト緑(+23)。
実装判断(コード内コメントにも記載): apiKey は LlmSettingsView(hasApiKey)で非露出+部分更新
(clearApiKey で削除)。DialogueProvider.suggest は messages も返す(request_json 保存の再現性のため)。
提案の panelId 不正は 400 でなく null 化+警告。adopt は dialogue_lines 作成のみ(配置は S3 フローに合流)。
シーン選定は配置済み行の scene_index 最頻値→ページ位置からの線形推定のヒューリスティック。
60s タイムアウトは LLM 1 呼び出し単位(リトライ合計では超え得る)。

### 目的
OpenAI 互換 LLM に「このページ(コマ構成・シーン文脈・キャラ口調)に合うセリフ案」を構造化 JSON で出させ、
採用すると dialogue_lines になる。**LLM の生出力・モデル名・脚本 revision・項目別の採用履歴を永続化。**

### DialogueProvider(画像の GenerationProvider とは別系統)
```ts
interface DialogueProvider {
  readonly id: string;                    // 'openai-compatible'
  suggest(ctx: DialogueSuggestContext): Promise<{ items: DialogueProposalItem[]; rawOutput: string; model: string }>;
}
```
初期実装は OpenAI 互換のみ。責務分離のため既存 llm.ts のプロンプト改善とはモジュールを分ける
(`src/server/dialogue/openaiCompatibleDialogueProvider.ts` 等)。共通 HTTP 層は下記 chatCompletion を共用。

### 前提整備(llm.ts の改修)
- `LlmSettings` に `apiKey?: string` を追加(Authorization: Bearer 条件付与。設定フォームに password input)。
- `llmFetchJson` の欠陥修正: **response.ok 判定 → JSON.parse の順**、abort 時は専用メッセージ、
  エラーボディは 500 文字程度に切り詰め。
- 汎用 `chatCompletion(settings, { messages, temperature?, responseFormat?, timeoutMs, signal? })` を export、
  improvePromptWithLlm はその薄いラッパーへ。
- リトライ分類: 401/403 → リトライしない(認証エラーを明示)/ 429・5xx → 短いバックオフで 1 回再試行 /
  スキーマ検証失敗 → エラー内容をメッセージに付けて再試行(最大 2 回)。

### 構造化生成(src/server/llmStructured.ts)
```ts
async function generateStructuredJson<T>(opts: {
  settings: LlmSettings;
  systemPrompt: string; userPrompt: string;
  schema: object;                          // JSON Schema(response_format 用)
  validate: (raw: unknown) => T | null;    // 手書き検証(repo 慣例。zod は入れない)
  maxRetries?: number; temperature?: number; signal?: AbortSignal;
}): Promise<{ value: T; rawOutput: string }>
```
- 1 回目: `response_format: { type: "json_schema", ... }`。失敗(非対応/パース不能/validate null)時は
  プロンプト誘導(「JSON のみ出力」+スキーマ提示)へフォールバックし、検証エラーを付けて再試行。
- コードフェンス除去等のベストエフォートパースを挟む。ローカル LLM の response_format 対応差への二段構え。

### DB(項目別採用履歴)
```sql
CREATE TABLE IF NOT EXISTS dialogue_proposals (
  id TEXT PRIMARY KEY,                    -- createId("proposal")
  project_id TEXT NOT NULL,
  script_id TEXT,
  script_revision_id TEXT,                -- 提案時点の script_revisions.id(stale 判定)
  page_id TEXT,
  model TEXT NOT NULL,
  request_json TEXT NOT NULL,             -- 送信 messages(再現性)
  raw_output TEXT,                        -- LLM 生出力 verbatim
  items_json TEXT,                        -- 検証済み提案配列+項目別状態(下記)
  status TEXT NOT NULL DEFAULT 'proposed',-- proposed | resolved | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
);
```
items_json の各項目:
```ts
type DialogueProposalItem = {
  panelId: string | null;
  speakerName: string;                    // character_id 解決はサーバ(aliases 突合)
  text: string;
  semanticKind: "dialogue" | "monologue" | "narration" | "sfx";
  emotion?: string;
  // 項目別の採用履歴
  itemStatus: "proposed" | "adopted" | "rejected" | "replaced";
  adoptedLineId?: string;                 // 採用で作られた dialogue_lines.id
  editedText?: string;                    // 手修正して採用した場合の最終文言
};
```
jsonColumnNames: `items_json→items`(request_json→request は既存登録を共用)。raw_output は生文字列のまま。

### プロンプト構成(src/server/dialogue/prompt.ts)
system: 「あなたは漫画のセリフ作家。出力は JSON のみ」+ スキーマ。
user: 該当シーン抜粋(scene_index 周辺)、コマ数と読み順(layout.panels order)、キャラクタ一覧
(name/notes/aliases)、既存の配置済みセリフ(重複回避)、指示(1 コマ 1〜2 行、sfx は擬音のみ等)。
temperature は呼び出しパラメータで上書き可(既定 settings.temperature)。

### API / UI
```
POST /api/projects/:id/pages/:pageId/dialogue-proposals   { scriptId?, instruction? }(60s timeout)
GET  /api/projects/:id/dialogue-proposals?pageId=
POST /api/dialogue-proposals/:id/adopt      { itemIndices: number[], edits?: {index, text}[] }
POST /api/dialogue-proposals/:id/reject     { itemIndices?: number[] }   // 省略 = 残り全部
```
UI: S3 のセリフドロワーに「AI セリフ提案」ボタン(llmConfigured 時のみ、llmImproving 同型の busy フラグ)。
提案リスト → 項目ごとに採用(文言修正可)/却下 → 採用分は dialogue_lines(source='llm', proposal_id)になり
S3 の手動配置フローに合流。**LLM 待ち中のページ移動ガード**(activePageId 捕捉)必須。

### 受け入れ条件
- 部分採用(一部項目のみ採用+文言修正)が動き、items_json に項目別履歴が残る。
- script_revision_id が最新でない提案は「脚本が更新されています」と stale 表示。
- スキーマ不正応答 → フォールバック再試行 → それでも失敗なら status='failed' + エラー要約トースト。
  401/403 は即時に認証エラー表示(リトライしない)。単体テストで検証(LLM はモックサーバ or 注入)。
- raw_output が残り、採用行から proposal_id で遡れる。

---

## 実装順・ブランチ運用

| 順 | ブランチ | 内容 | 主な受け入れ検証 |
|---|---|---|---|
| S1 | `s1-generation-provider` | Intent/Provider 抽象化(v2 修正含む) | 既存テスト緑 + FakeProvider 契約テスト + ヘッドレススモーク |
| S2 | `s2-image-object` | ImageObject + 帯 + page_media | 3 書き出し経路 + 保存往復 + Round削除耐性 |
| S3 | `s3-script-domain` | 脚本ドメイン + Fountain + 手動配置 | パーサ単体 + 再取り込み差分照合 + 配置 E2E |
| S4 | `s4-dialogue-llm` | DialogueProvider + 構造化提案 | 検証/リトライ/部分採用/stale 単体テスト |

- 各ブランチは worktree で作業し、レビュー(正しさ/スキーマ安全性/慣例)→修正→ main へマージ。
  マージ後に `bun run typecheck` / `bun test` / `bun run check`。
- S2 以降は直前フェーズマージ後の main から分岐(apiTypes.ts / db.ts / index.ts の競合回避)。

## 既知の罠(実装者向けチェックリスト)
1. shared normalize は未知 kind/フィールドを黙って捨てる → 新フィールドは normalize 更新とセットで。
2. jsonColumnNames 登録漏れ → API に生 JSON 文字列が出る(エラーにならない)。テーブル横断グローバルキー。
3. SQLite ALTER ADD COLUMN は NOT NULL に定数 DEFAULT 必須。DEFAULT なし NOT NULL はゴミ箱復元も壊す。
4. SVG: scale(1000) g の外は不可視 / fill="none" はヒットしない(transparent を使う)。
5. registerActions の名前重複は起動時 throw。
6. 非同期完了後の state 書き込みは activePageId/currentProjectId 捕捉ガード必須。
7. モーダル backdrop 判定は if/else 順序依存(main.ts:221-238)。regions 配列への追加漏れは無音バグ。
8. `bun run check` は typecheck/test を含まない。3 点セットを回すこと。
9. テストは node:test + node:assert/strict、相対 import は .ts 拡張子明示。
10. main.ts への関数追加は禁止(AGENTS.md)。専用 controller + registerActions/registerEventBinder。
11. SELECT * + toApiRow で追加列は無条件に API 露出 → 秘密・ローカル絶対パスを新列/intent_json に入れない。
12. providerOptions / binding_json の中身はオーケストレータで読まず、Provider 側で検証・正規化する。
