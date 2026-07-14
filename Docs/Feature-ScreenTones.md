# スクリーントーン機能(2026-07-14)

漫画で使う代表的なトーン(網点・グラデ・線トーン・スピード線・集中線・ベタフラッシュ)をページ
オブジェクトとして追加・編集できるようにする。CLIP STUDIO 等の「集中線は中心位置と半径を指定して
編集できる」体験を参考にする(ユーザー要望)。本書が仕様の正。UX バッチは別紙
`Docs/Feature-PageEditSidebarUx.md`。

## 方針

- **新オブジェクト kind `"tone"`** を追加する(`src/shared/pageObjects.ts`)。既存の
  box/balloon/text/image と同じく `pages.objects_json` に保存され、移動/拡縮/回転/z順/表示切替/
  削除・undo/redo・debounce 保存の既存装置にそのまま乗る。
- **描画は共有純ロジック `src/shared/toneSvg.ts`** に一本化する(`renderBalloonSvg` /
  `renderTextSvg` と同じ役割分担)。クライアントのステージ描画とサーバの書き出し
  (`openRasterExport.createPageLayers` → PNG/JPEG/PPTX/ORA 全経路)が同じ関数を使うことで
  プレビューと書き出しの見た目を一致させる。
- 乱数(スピード線/集中線/フラッシュのゆらぎ)は **seed 付き決定的 PRNG**(mulberry32 等を
  toneSvg.ts 内に実装)。同じオブジェクトからは常に同じ SVG 文字列が出る(スナップショット
  テスト可能、再描画・書き出しで見た目が揺れない)。
- 既存の自動効果線(`src/shared/mangaEffects.ts`、box の集まりで線を近似する休眠コード)は
  触らない・流用しない(将来 tone へ置き換える余地をレポートに書くのは歓迎)。

## データモデル

```ts
export type ToneKind = "halftone" | "gradient" | "lines" | "speed" | "focus" | "flash";

export interface ToneObject extends PageObjectBase {
  kind: "tone";
  /** 領域(外接矩形)。position=中心、box と同じ page 単位。 */
  size: PageVec;
  toneType: ToneKind;
  /** 描画色。既定 "#000000"。 */
  color: string;
  /** 0..1、既定 1。 */
  opacity?: number;
  /** コマ形状でクリップ(ImageObject.clipPanelId と同じ仕組み・同じ clipPath defs を再利用)。 */
  clipPanelId?: string | null;
  /** ゆらぎの決定的乱数 seed(整数)。作成時に採番、「シャッフル」で振り直し。 */
  seed: number;
  params: ToneParams; // toneType 別(下表)
}
```

`ToneParams`(判別 union でも単一オブジェクトでも良いが、**正規化で全フィールド保持**すること):

| toneType | パラメータ(page-width 単位 / 角度は deg) | 既定値の目安 |
| --- | --- | --- |
| halftone(網点) | `pitch`(ドット間隔 0.004–0.1)、`dotRatio`(濃度 0–1)、`angle` | 0.015 / 0.45 / 45 |
| gradient(グラデトーン) | halftone + `startRatio`/`endRatio`(角度方向に濃度遷移) | 0.7 → 0.05 |
| lines(線トーン) | `pitch`、`lineRatio`(線幅/間隔 0–1)、`angle` | 0.012 / 0.35 / 0 |
| speed(スピード線) | `angle`、`count`(≤400)、`length`(平均長 0–1)、`lineWidth`、`jitter`(0–1) | 45 / 90 / 0.7 / 0.004 / 0.5 |
| focus(集中線) | `center: PageVec`(**ローカル座標**: オブジェクト中心=原点、balloon tail.tip と同方式)、`innerRadius`(中心の空白半径)、`count`(≤400)、`lineWidth`(外周側の基部太さ)、`jitter` | (0,0) / 0.12 / 72 / 0.012 / 0.5 |
| flash(ベタフラッシュ) | focus と同じ(領域を色で塗り、中心から innerRadius+ゆらぎのギザギザ白抜き) | innerRadius 0.18 |

- 角度パラメータは **deg で保存**(UI の number 入力と一致させる。object.rotation(rad)とは別物で、
  rotation は領域ごと回す)。
- `normalizePageObjects` に tone の正規化を追加: 範囲 clamp(pitch 下限 0.004 は要素数爆発防止の
  安全弁)、未知 toneType は捨てる、**seed/params/clipPanelId を必ず往復保持**(「正規化往復で
  編集が巻き戻る」既知の罠)。

## 描画仕様(toneSvg.ts)

- シグネチャは `renderBalloonSvg` に合わせる(例: `renderToneSvg(object, anchor, rotation): string`)。
  クライアントは `renderPageObjectShape` の分岐から、サーバは `openRasterExport.ts` の band 別
  SVG 合成(`kind === "box"` 等の並び)から呼ぶ。
- halftone / lines: `<pattern patternUnits="userSpaceOnUse">` + `patternTransform="rotate(...)"` を
  領域 rect に敷く。gradient は pattern + `<mask>`(`<linearGradient>`)で濃度遷移を近似して良い
  (v1 はドット径固定+マスク減衰で可)。
- speed / focus / flash: seed 付き PRNG で線(先細りの三角形/四角形ポリゴン。stroke ではなく
  fill パス — 漫画的なシャープさと librsvg 互換のため)を生成。`count` は 400 に clamp。
  focus は「領域外周 → center 方向へ、innerRadius で止まる」線群。flash は領域を color で塗り、
  中心の innerRadius ± ゆらぎの星形を白(=透過ではなく `#ffffff`)で抜くか `<mask>` で抜く。
- 全要素は領域 rect への `<clipPath>` でクリップし、`clipPanelId` があれば既存のコマ clipPath
  (`panelClipId`)を外側に重ねる(ImageObject と同じ二重クリップ構成)。
- **id 衝突禁止**: pattern/mask/clipPath の id は `object.id` を含めて一意化(サーバは1つの SVG に
  複数オブジェクトを並べるため必須)。id に使えない文字はサニタイズ(panelClipId の前例あり)。
- sharp(librsvg)は pattern / mask / clipPath / patternTransform をサポートする — 書き出しテストで
  実際にラスタライズして確認すること。

## エディタ UI

- 追加ボタン「+ トーン」を追加グリッドへ(吹き出し/テキスト/ボックス/画像の並び)。
  - コマ選択中に押した場合: そのコマの外接矩形を領域にし `clipPanelId = そのコマ` で作成
    (コマにトーンを貼る主要ユースケースを1クリック化)。
  - 未選択: ページ中央に 0.35×0.35 で作成。既定 toneType は halftone。
- SETTINGS パネル(tone 選択時): 種別 select(6種)・種別ごとのパラメータ欄・色・不透明度・
  クリップ先コマ select(image と同じ)・「シャッフル」ボタン(speed/focus/flash の seed 振り直し)。
  種別を切り替えたら params はその種別の既定値へリセットする。
- **focus / flash は中心ハンドル**: しっぽ tip ハンドル(`data-page-object-handle="tail"`)と同じ
  パターンで `"tone-center"` ジェスチャを追加し、ステージ上で中心をドラッグできるようにする
  (ローカル座標への変換・回転の扱いは tail の実装を踏襲)。ハンドル色は tail のオレンジと
  区別できる色に。innerRadius は v1 は number 入力で可(リングハンドルは任意)。
- ギズモ(移動/拡縮/回転)は box と同等(`gizmoBoxForPageObject` へ tone を追加)。
- レイヤ一覧: 名前「トーン」、type 欄に種別の日本語(網点/グラデ/線/スピード線/集中線/フラッシュ)。

## 組み込みチェックリスト

`rg -n 'kind === "image"' src/` の各所が「新 kind を足す時に触る場所」の実質的な一覧になっている
(image が最後に追加された kind)。最低限:

- shared: `pageObjects.ts`(型・normalize・create・clone は JSON 往復なので自動)+ `toneSvg.ts` 新設
- client: `pagePanelLightboxView.ts`(renderPageObjectShape 分岐・追加ボタン・SETTINGS パネル・
  レイヤ名)、`pageObjectsController.ts`(追加 action・フィールド更新・isEditableObject・
  editableObjectUnchanged・ギズモ拡縮で params の長さ系もスケールするか判断 — v1 は size のみで可・
  tone-center ジェスチャ)、`pageObjectGizmoBox.ts`、`pageLayers.ts`(band: tone は front 固定)
- server: `openRasterExport.ts`(band SVG 合成に tone 分岐)— これだけで PNG/JPEG/PPTX/ORA 全対応
- styles: ハンドル・パネルの微修正

## テスト

- `src/shared/toneSvg.test.ts`: 同一オブジェクト→同一 SVG(決定性)、seed 変更→変化、count/pitch の
  clamp、id の一意性(2オブジェクト並置)、focus の innerRadius 空白(中心付近に線が届かない)。
- `src/shared/pageObjects.test.ts`: tone の正規化往復(seed/params/clipPanelId/opacity 保持)、
  不正値の clamp、未知 toneType の破棄。
- `src/server/openRasterExport.test.ts`: tone を含むページの書き出しスモーク(例外なく PNG が出る、
  トーン有無でピクセルが変化する程度の緩い検証)。
- `bun test` 全体緑・`bun run typecheck` 緑。

## 変更履歴

- 2026-07-14: 初版。
