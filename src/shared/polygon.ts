/**
 * 多角形の shoelace(靴紐)面積の共有実装。panelShapeEdit.ts / layoutPresets.ts / panelBezier.ts に
 * 同一ロジックが3重実装されていたため統合(挙動は不変)。
 */

/**
 * 符号付き面積(shoelace 公式そのまま)。SVG の y-down 座標系では時計回りが正。
 * 3頂点未満は数学的に厳密へ 0 になる(ガード不要)。
 */
export function polygonSignedArea(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** shoelace 公式による多角形面積(符号なし)。 */
export function polygonArea(points: readonly (readonly [number, number])[]): number {
  return Math.abs(polygonSignedArea(points));
}
