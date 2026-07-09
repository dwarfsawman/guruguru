/**
 * SVG ギズモ(移動/拡縮/回転)共通ユーティリティ(Docs/Feature-CGCollectionSuite.md P1)。
 * paste(`pasteObjectController.ts`/`pasteTransform.ts`)とコマクロップ(`pagePanelLightboxController.ts`)で
 * 同型実装が2つあったため、3例目(ページオブジェクトの box ギズモ)を作る前に純ロジックだけ抽出した。
 * **既存2実装は書き換えない**(回帰リスク回避) — 新ギズモ(`pageObjectsController.ts`)だけがここを使う。
 *
 * pasteTransform.ts との違い: あちらは「中心 + 回転 + scaleX/scaleY(natural px 単位)」モデルだが、
 * ここでは「中心 + 回転 + size(幅・高さを直接持つ、任意の座標系単位)」モデルを使う
 * (ページオブジェクトの box は crop の「窓」ではなく実寸の矩形のため)。
 * 数学的な骨格(中心距離比での uniform scale・atan2 回転+スナップ)は同じ考え方を踏襲している。
 */

export interface GizmoVec {
  x: number;
  y: number;
}

/** 中心 + サイズ + 回転(ラジアン)で表す矩形。ページオブジェクトの box はこの形で操作する。 */
export interface GizmoBox {
  center: GizmoVec;
  size: GizmoVec;
  rotation: number;
}

/** 画面px ⇄ SVG(getScreenCTM 由来の)座標変換。 */
export interface StageTransform {
  /** 画面px / 1 SVG単位。ctm.a(uniform scale 前提。回転していない基準要素から取ること)。 */
  pxPerUnit: number;
  /** SVG 座標(getScreenCTM を持つ要素のローカル単位)→ 画面px 座標。 */
  toScreen: (point: GizmoVec) => GizmoVec;
}

/**
 * `el.getScreenCTM()` から `StageTransform` を作る。**回転していない**(scale(N) 等の単純な拡大のみの)
 * 要素から取ること — 対象オブジェクト自身の rotate transform が乗った要素から取ると
 * ctm.a が cos(rotation) で汚染され、pxPerUnit が不正確になる(crop 実装の既知の制約と同じ罠)。
 * ctm が取れない(非表示等)場合は null。
 */
export function getStageTransform(el: SVGGraphicsElement): StageTransform | null {
  const ctm = el.getScreenCTM();
  if (!ctm || !ctm.a) {
    return null;
  }
  return {
    pxPerUnit: ctm.a,
    toScreen: (point) => ({
      x: ctm.a * point.x + ctm.c * point.y + ctm.e,
      y: ctm.b * point.x + ctm.d * point.y + ctm.f
    })
  };
}

/**
 * `getStageTransform` の逆方向: 画面px座標を(回転していない基準要素の)SVG正規化座標へ変換する関数を返す。
 * paste/crop/オブジェクトの既存ギズモは中心固定のデルタ計算(pxPerUnit で割るだけ)で済んでいたため
 * 逆変換は不要だったが、コマ形状編集(P5)の分割線ドラッグは「ポインタの絶対位置をそのままステージ座標
 * として使いたい」ため、これが要る。ctm が取れない(非表示等)場合は null。
 */
export function getInverseStageTransform(el: SVGGraphicsElement): ((screen: GizmoVec) => GizmoVec) | null {
  const ctm = el.getScreenCTM();
  if (!ctm || !ctm.a || !ctm.d) {
    return null;
  }
  return (screen) => ({
    x: (screen.x - ctm.e) / ctm.a,
    y: (screen.y - ctm.f) / ctm.d
  });
}

/** 点を center まわりに角 rotation(rad, SVG y-down の時計回り)だけ回す。 */
export function rotatePointAround(point: GizmoVec, center: GizmoVec, rotation: number): GizmoVec {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** 回転した矩形の4頂点([左上, 右上, 右下, 左下]の順、回転前基準)。 */
export function gizmoBoxCorners(box: GizmoBox): GizmoVec[] {
  const halfX = box.size.x / 2;
  const halfY = box.size.y / 2;
  const local: GizmoVec[] = [
    { x: box.center.x - halfX, y: box.center.y - halfY },
    { x: box.center.x + halfX, y: box.center.y - halfY },
    { x: box.center.x + halfX, y: box.center.y + halfY },
    { x: box.center.x - halfX, y: box.center.y + halfY }
  ];
  return local.map((point) => rotatePointAround(point, box.center, box.rotation));
}

/** 上辺中央(回転後)。回転ハンドルの基準点。 */
export function gizmoTopMid(box: GizmoBox): GizmoVec {
  return rotatePointAround({ x: box.center.x, y: box.center.y - box.size.y / 2 }, box.center, box.rotation);
}

/** 回転後の「上」方向の単位ベクトル(ローカル -Y を rotation 回した向き)。 */
export function gizmoUpVector(rotation: number): GizmoVec {
  return { x: Math.sin(rotation), y: -Math.cos(rotation) };
}

export interface GizmoViewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 回転ハンドルの位置。`topMid` から外向き `up` に `stick` 伸ばすのが基本だが、
 * その位置が `bounds` の外(ステージにクリップされて掴めない)なら内向きへ反転する
 * (`cropRotateHandlePoint` と同じ考え方の一般化)。
 */
export function gizmoRotateHandlePoint(topMid: GizmoVec, up: GizmoVec, stick: number, bounds: GizmoViewBounds): GizmoVec {
  const outward: GizmoVec = { x: topMid.x + up.x * stick, y: topMid.y + up.y * stick };
  if (outward.x < bounds.minX || outward.x > bounds.maxX || outward.y < bounds.minY || outward.y > bounds.maxY) {
    return { x: topMid.x - up.x * stick, y: topMid.y - up.y * stick };
  }
  return outward;
}

/** 画面基準px(ハンドル半径等)を SVG 単位へ変換する。 */
export function gizmoScreenPxToUnits(pxPerUnit: number, px: number): number {
  return pxPerUnit > 0 ? px / pxPerUnit : px;
}

/** 中心固定の移動。dx/dy は SVG 単位(すでに pxPerUnit で割った後の値)。 */
export function moveGizmoBox(box: GizmoBox, dx: number, dy: number): GizmoBox {
  return { ...box, center: { x: box.center.x + dx, y: box.center.y + dy } };
}

/**
 * 中心固定の uniform 拡縮。`factor` は「中心→現在ポインタ距離 / 中心→開始ポインタ距離」。
 * 結果の size が [minSize, maxSize] を割らない/超えない範囲へ実効 factor をクランプする
 * (`scaleCropAboutCenter` と同じ考え方 — 縦横比は必ず保つ)。
 */
export function scaleGizmoBoxAboutCenter(box: GizmoBox, factor: number, minSize: number, maxSize: number): GizmoBox {
  const baseX = box.size.x > 0 ? box.size.x : 1;
  const baseY = box.size.y > 0 ? box.size.y : 1;
  const maxFactor = Math.min(maxSize / baseX, maxSize / baseY);
  const minFactor = Math.min(maxFactor, Math.max(minSize / baseX, minSize / baseY));
  const effective = Math.min(maxFactor, Math.max(minFactor, Number.isFinite(factor) && factor > 0 ? factor : 1));
  return { ...box, size: { x: baseX * effective, y: baseY * effective } };
}

/** 角度を (-π, π] へ正規化(非数は 0)。 */
export function normalizeGizmoAngle(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const twoPi = Math.PI * 2;
  let r = value % twoPi;
  if (r <= -Math.PI) {
    r += twoPi;
  } else if (r > Math.PI) {
    r -= twoPi;
  }
  return r;
}

/**
 * 回転ジェスチャ(中心周り atan2 差分)。`startAngle`/`currentAngle` は
 * `Math.atan2(pointerY - centerScreenY, pointerX - centerScreenX)` で呼び出し側が求める
 * (画面px 空間の角度。SVG が回転していない前提であれば SVG 空間の角度とも一致する)。
 * snap(Shift 押下)時は 15° 刻みへスナップする。
 */
export function rotateGizmoBox(
  box: GizmoBox,
  startAngle: number,
  currentAngle: number,
  snap: boolean,
  snapStepRad = Math.PI / 12
): GizmoBox {
  let rotation = box.rotation + (currentAngle - startAngle);
  if (snap) {
    rotation = Math.round(rotation / snapStepRad) * snapStepRad;
  }
  return { ...box, rotation: normalizeGizmoAngle(rotation) };
}
