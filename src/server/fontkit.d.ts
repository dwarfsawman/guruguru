/**
 * `fontkit` は型定義を同梱していない(@types/fontkit も存在しない)ので、実際に使う範囲だけの
 * 最小限のアンビエント型を手書きする(Docs/Feature-CGCollectionSuite.md P2)。フルAPIは
 * node_modules/fontkit/README.md 参照。
 */
declare module "fontkit" {
  export interface FontkitPath {
    toSVG(): string;
  }

  export interface FontkitGlyph {
    id: number;
    advanceWidth: number;
    path: FontkitPath;
  }

  export interface FontkitGlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface FontkitGlyphRun {
    glyphs: FontkitGlyph[];
    positions: FontkitGlyphPosition[];
  }

  export interface FontkitFont {
    type: string;
    /** 名前テーブルの解決に失敗した/非Unicodeエンコーディングの場合は生バイト列(Uint8Array)のことがある。 */
    familyName: string | Uint8Array | null;
    subfamilyName: string | Uint8Array | null;
    postscriptName: string | Uint8Array | null;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    getName(key: string, lang?: string): string | Uint8Array | null;
    glyphForCodePoint(codePoint: number): FontkitGlyph;
    hasGlyphForCodePoint(codePoint: number): boolean;
    layout(text: string, features?: string[] | Record<string, boolean>): FontkitGlyphRun;
  }

  export interface FontkitCollection {
    type: "TTC";
    fonts: FontkitFont[];
    getFont(postscriptName: string): FontkitFont | null;
  }

  export function openSync(filename: string, postscriptName?: string | null): FontkitFont | FontkitCollection;
  export function open(filename: string, postscriptName?: string | null): Promise<FontkitFont | FontkitCollection>;
  export function create(buffer: Uint8Array, postscriptName?: string | null): FontkitFont | FontkitCollection;
}
