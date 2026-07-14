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
export type ToneKind = "halftone" | "gradient" | "lines" | "speed" | "focus" | "flash" | "noise" | "snow";

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
| gradient(グラデトーン) | halftone + `startRatio`/`endRatio`(角度方向に濃度遷移)+ 任意の `gradStart`/`gradEnd`(2026-07-15: 遷移軸のローカル2点。ステージ上のハンドルで編集、両方有効な時だけ使い、2点の外側は最寄り端の濃度で平坦。未指定は従来どおり angle 方向に領域全体で遷移) | 0.7 → 0.05 / 2点は未指定 |
| lines(線トーン) | `pitch`、`lineRatio`(線幅/間隔 0–1)、`angle` + 任意の `startRatio`/`endRatio`(2026-07-14 追補の濃度グラデ)+ 任意の `gradStart`/`gradEnd`(2026-07-15 追補2: 遷移軸のローカル2点。gradient と同じステージ上のハンドルで編集。指定時は縞の向きも軸と直交へ追従し、2点の外側は最寄り端の濃度で平坦。未指定は従来どおり angle の縞+angle+90 方向に領域全体で遷移) | 0.012 / 0.35 / 0 / グラデなし |
| speed(スピード線) | `angle`、`count`(≤400)、`length`(平均長 0–1)、`lineWidth`、`jitter`(0–1) | 45 / 90 / 0.7 / 0.004 / 0.5 |
| focus(集中線) | `center: PageVec`(**ローカル座標**: オブジェクト中心=原点、balloon tail.tip と同方式)、`innerRadius`(中心の空白半径)、`count`(≤400)、`lineWidth`(外周側の基部太さ)、`jitter` | (0,0) / 0.12 / 72 / 0.012 / 0.5 |
| flash(ベタフラッシュ) | focus と同じフィールド構成(領域を色で塗り、中心に星形の白抜き)。`lineWidth` は flash では**棘の長さ**(山の基準突出量)の意味(2026-07-15 刷新) | innerRadius 0.18 / lineWidth 0.08 |
| noise(砂ノイズ) | `density`(0–1)、`grain`(粒サイズ、0.001–0.02)、任意で `angle`+`startRatio`/`endRatio`(角度方向の密度グラデ) | 0.35 / 0.003 / グラデなし |
| snow(雪・玉ボケ) | `count`(≤400、前面+背面合計)、`frontRatio`(前面の割合 0–1)、`frontSize`/`backSize`(楕円長径)、`frontBlur`/`backBlur`(ぼかし強さ、サイズ比)、`angle`(落下方向=楕円の伸び方向)、`backColor`(#rrggbb、背面粒の色) | 120 / 0.4 / 0.05 / 0.03 / 0.5 / 0.3 / 115 / #aaaaaa |

### 追補(2026-07-14 参考アプリとの突き合わせで追加)

- **noise / snow を追加**(上表)。noise は seed 付き乱数の粒を**タイル化した `<pattern>`**で敷く
  (全面に個別要素を撒くと要素数が爆発するため。タイルは領域の 1/2〜1/4 程度の大きさで、
  タイル境界の繰り返しが目立たない粒数にする)。グラデは他種別と同じ `<mask>` 方式。
  snow は seed 付きで楕円(angle 方向に伸びる)を前面/背面の2層生成し、`<filter>` の
  `feGaussianBlur` でぼかす(librsvg の feGaussianBlur 対応は書き出しスモークテストで実証すること。
  ぼかしフィルタの id もオブジェクト id で一意化)。前面=object.color、背面=params.backColor。
- **lines に任意の濃度グラデ**: `startRatio`/`endRatio` を optional で追加(指定時のみ mask を掛ける。
  遷移方向は線の伸びる向きと直交=縞をまたぐ方向)。
- **gradient(網グラデ)をドット径の真の遷移へ強化**: v1 のマスク減衰近似をやめ、seed 不要の
  行生成(角度方向に沿って各ドットの半径を start→end へ補間した `<circle>` 群)にする。
  **要素数バジェット必須**: 領域面積/pitch² が約2万ドットを超える場合は実効 pitch を自動で
  粗くして上限内に収める(書き出し時間と SVG サイズの暴走防止)。
- **focus に `outerRadius`(任意)**: 指定時は線の外側の端を「領域端」ではなく center から
  outerRadius の円周までにする(参考アプリの「最大半径」相当)。未指定は従来どおり領域端から。

### 追補(2026-07-15 ユーザーフィードバック)

- **トーン本体のドラッグ移動不能を修正**: `renderToneSvg` のルート `<g class="page-object-tone-shape">` に
  対する `pointer-events: none` の CSS が欠落しており(balloon/text/image には同等ルールあり)、塗りの
  ある種別(flash のベタ塗り、halftone/lines/noise のパターン rect)が兄弟のヒット矩形を覆って
  pointerdown を奪っていた。本体は `data-page-object` を持たないため「背景クリック=選択解除」扱いに
  なり、クリック選択も本体ドラッグ移動もできなかった。CSS 1ルール追加で修正。
- **gradient に始点/終点ハンドル**(参考アプリの「グラデ始点X/Y・終点X/Y」相当): optional な
  `params.gradStart`/`gradEnd`(ローカル2点、center と同方式・±2 clamp)を追加。描画・ハンドル位置の
  両方が `toneSvg.ts` の `effectiveGradientPoints`(未指定は angle 由来の領域両端へフォールバック)を
  使うことで、ハンドルと見た目を常に一致させる。ドット格子の向きも遷移軸に追従。未指定でもハンドルは
  実効位置に常に表示し、最初のドラッグで**両方**を materialize する(片方だけ保存すると残りが angle
  由来のまま動いてしまうため)。gradient の「角度」入力はハンドル指定時は実質無効になるため、角度を
  入力したら gradStart/gradEnd を削除して角度指定へ戻す(最後の編集が勝つ)。
- **flash(ベタフラッシュ)の描画刷新**: v1 は頂点ごとに半径を独立乱択した多角形で、輪郭が低周波に
  うねる「子供の落書き」状だった(ユーザー指摘)。v2 は「山(棘の先端)と谷(白核の縁)が交互に並ぶ
  星形」にする -- 谷は innerRadius 近傍に揃えて白核の輪郭を円に近く保ち、山だけを外へ尖らせる。
  `lineWidth` は「棘の長さ」(基準突出量)へ意味を変更し既定 0.08(UI ラベルも flash のみ「棘の長さ」)。
  jitter は棘の長さ ±85%・山の角度 ±1/4 ステップ(隣の谷を跨がない=自己交差しない)・谷の凹み(最大
  -18%)+低確率の長い棘(1.7倍)に効く。既存オブジェクト(lineWidth 0.012 のまま)は棘が短く出るが、
  種別を切り替え直すか「棘の長さ」を上げれば新既定の見た目になる。

### 追補2(2026-07-15 ユーザーフィードバック続き)

- **lines にも始点/終点ハンドル**(gradient と同じ UX): 濃度グラデ(startRatio/endRatio)有効時のみ、
  緑=始点/青=終点のハンドルと破線の軸線をステージへ常時表示し、ドラッグで遷移の向きと範囲を指定できる
  (optional な `params.gradStart`/`gradEnd` を lines でも正規化保持)。実効2点は共通の
  `effectiveGradientPoints(toneType, ...)` -- lines のフォールバック方向は縞と直交の **angle+90**
  (gradient は angle そのもの)なので、未指定時の見た目は従来と一致する。
  - mask の線形グラデは bbox 基準の rotate をやめ、実効2点へ `gradientUnits="userSpaceOnUse"` で直接
    張る(非正方形領域でも遷移方向がハンドルの軸線と厳密に一致する)。spreadMethod 既定(pad)により
    **2点の外側は最寄り端の濃度で平坦**(始点より手前=開始濃度、終点より先=終了濃度)。
  - **縞の向きは遷移軸と直交へ追従**する(「遷移=縞をまたぐ方向」の関係を維持)。「角度」を入力すると
    gradient と同様に gradStart/gradEnd を削除して角度指定へ戻す(最後の編集が勝つ)。
  - 濃度グラデのチェックを外したら gradStart/gradEnd も一緒に破棄する(再有効化は angle 由来の軸から。
    残すと再有効化時に古い軸が復活して角度編集を無視するため)。noise の濃度グラデは従来どおり
    angle+bbox mask のまま(ハンドルなし、対象外)。

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
  中心に「山と谷が交互の星形」(谷=innerRadius 近傍、山=innerRadius+棘の長さ。2026-07-15 刷新)を
  白(=透過ではなく `#ffffff`)で抜く。
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
- SETTINGS パネル(tone 選択時): 種別 select(8種)・種別ごとのパラメータ欄・色・不透明度・
  クリップ先コマ select(image と同じ)・「シャッフル」ボタン(speed/focus/flash/noise/snow の seed 振り直し)。
  種別を切り替えたら params はその種別の既定値へリセットする。
- **focus / flash は中心ハンドル**: しっぽ tip ハンドル(`data-page-object-handle="tail"`)と同じ
  パターンで `"tone-center"` ジェスチャを追加し、ステージ上で中心をドラッグできるようにする
  (ローカル座標への変換・回転の扱いは tail の実装を踏襲)。ハンドル色は tail のオレンジと
  区別できる色に。innerRadius は v1 は number 入力で可(リングハンドルは任意)。
- **gradient / lines は始点/終点ハンドル**(2026-07-15 追補、lines は同日追補2): 緑=始点(tone-center
  と同色)/青=終点(`"tone-grad-start"`/`"tone-grad-end"` ジェスチャ)。2点間に破線の軸線を描いて
  遷移方向を可視化する。gradStart/gradEnd 未指定でも実効位置(angle 由来)にハンドルを常に出し、
  最初のドラッグで両方を materialize する。数値入力は設けない(center と同じ方針)。「角度」を入力すると
  ハンドル指定はリセットされ角度指定へ戻る。lines のハンドルは**濃度グラデ有効時のみ**表示する
  (表示条件は mask を掛ける判定と同じ `hasOptionalGradient` -- グラデ無しでは操作対象が無いため)。
  flash のパラメータ欄は「線幅」ラベルを「棘の長さ」にする。
- ギズモ(移動/拡縮/回転)は box と同等(`gizmoBoxForPageObject` へ tone を追加)。
- レイヤ一覧: 名前「トーン」、type 欄に種別の日本語(網点/グラデ/線/スピード線/集中線/フラッシュ/ノイズ/雪)。
- **追補(2026-07-14)の optional パラメータ欄**: lines/noise の濃度グラデ(startRatio/endRatio)、
  focus の最大半径(outerRadius)は、`maxWidthEnabled`/`tailEnabled` と同じ「チェックボックスで
  optional フィールドの有無を切り替える」パターンで表示する(値は `updateToneOwnField` 側でトグル、
  数値自体は `updateToneParamField` 経由)。snow の backColor は `color系` フィールドとして
  `updateToneOwnField` が扱う(`data-page-object-field="backColor"`。文字列なので Number() に流さない)。

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
- 2026-07-14: 追補(参考アプリとの突き合わせ)を実装。noise(砂ノイズ、粒をタイル化 pattern で敷く)・
  snow(雪・玉ボケ、前面/背面2層+feGaussianBlur)を新種別として追加。lines に任意の濃度グラデ
  (startRatio/endRatio optional)、gradient をマスク近似から角度方向のドット半径行生成+要素数
  バジェット(約2万ドット)へ強化、focus に任意の outerRadius(最大半径)を追加。
- 2026-07-15: 追補(ユーザーフィードバック)を実装。(1) トーン本体の pointer-events 欠落で本体クリック/
  ドラッグ移動が「背景クリック=選択解除」化していたバグを CSS で修正、(2) gradient に始点/終点ハンドル
  (gradStart/gradEnd、緑/青のハンドル+破線軸線、角度入力でリセット)、(3) flash の描画を山谷交互の
  星形へ刷新(lineWidth=棘の長さ・既定 0.08、UI ラベル変更)。
- 2026-07-15: 追補2を実装。lines(線トーン)にも gradient と同じ始点/終点ハンドルを追加(濃度グラデ
  有効時のみ表示、gradStart/gradEnd を lines でも保持、mask は実効2点への userSpaceOnUse 線形グラデ=
  2点の外側は最寄り端の濃度で平坦、縞の向きは遷移軸と直交へ追従、角度入力・グラデ無効化でリセット)。
