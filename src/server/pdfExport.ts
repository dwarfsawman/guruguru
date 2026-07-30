/**
 * 完成品の PDF 書き出し。`imageExport.ts` の `/export-images` の `format` 選択肢の1つで、
 * エンドポイントは新設しない(PPTX と同じ方針)。
 *
 * PDF を手組みするのは PPTX の OOXML 手組みと同じ理由で、依存を増やさないため。
 * ページ画像は **JPEG をそのまま `DCTDecode` で埋める**。PDF は JPEG ストリームを
 * 再エンコードなしで持てるので、画素を触らずに済み、実装も小さくなる。
 *
 * オブジェクト番号は先に確定させる(1=Catalog, 2=Pages, i番目のページは 3+3i / 4+3i / 5+3i)。
 * 後から差し替えると xref のオフセットがずれるため、プレースホルダは使わない。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizeFileExport, type FileExportMetrics, type FileExportResult } from "./fileExport";

/** PDF のユーザー空間単位は 1/72 インチ。書き出しは 150dpi 相当で置く。 */
const PDF_DPI = 150;
const POINTS_PER_INCH = 72;

/**
 * JPEG のフレームヘッダから画素サイズを読む。
 *
 * PDF の XObject は幅・高さを自分で持つ必要があり、ここがずれると絵が伸びる。
 * SOF0/1/2/9/10 のいずれかを走査する(プログレッシブ JPEG は SOF2)。
 */
export function readJpegSize(buffer: Uint8Array): { width: number; height: number } {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    // スタンドアロンマーカー(長さフィールドを持たない)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (buffer[offset + 2]! << 8) | buffer[offset + 3]!;
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc9 && marker <= 0xcb);
    if (isFrame) {
      const height = (buffer[offset + 5]! << 8) | buffer[offset + 6]!;
      const width = (buffer[offset + 7]! << 8) | buffer[offset + 8]!;
      if (width > 0 && height > 0) return { width, height };
    }
    if (marker === 0xda) break; // スキャン開始以降にフレームヘッダは無い
    offset += 2 + length;
  }
  throw new Error("JPEG frame header not found");
}

/** ページ画像(JPEG)の列から PDF を組み立てる。 */
export function buildPdf(jpegPages: ReadonlyArray<Uint8Array>): Uint8Array {
  if (jpegPages.length === 0) throw new Error("PDF export requires at least one page");
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsetByNumber = new Map<number, number>();
  let position = 0;

  const push = (data: Uint8Array | string): void => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    position += bytes.byteLength;
  };
  const startObject = (number: number): void => {
    offsetByNumber.set(number, position);
    push(`${number} 0 obj\n`);
  };

  const pageNumbers = jpegPages.map((_, index) => 3 + index * 3);
  const totalObjects = 2 + jpegPages.length * 3;

  push("%PDF-1.4\n");
  // 画像を含むので、転送系がテキスト扱いしないようバイナリコメントを置く。
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  startObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject(2);
  push(`<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] >>\nendobj\n`);

  jpegPages.forEach((jpeg, index) => {
    const { width, height } = readJpegSize(jpeg);
    const widthPt = (width / PDF_DPI) * POINTS_PER_INCH;
    const heightPt = (height / PDF_DPI) * POINTS_PER_INCH;
    const pageNumber = pageNumbers[index]!;
    const contentsNumber = pageNumber + 1;
    const imageNumber = pageNumber + 2;

    startObject(pageNumber);
    push(
      `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> ` +
      `/Contents ${contentsNumber} 0 R >>\nendobj\n`
    );

    // 画像はページ全面へ置く(cm でユーザー空間を画像サイズへ拡大してから 1x1 で描く)。
    const content = encoder.encode(`q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`);
    startObject(contentsNumber);
    push(`<< /Length ${content.byteLength} >>\nstream\n`);
    push(content);
    push("\nendstream\nendobj\n");

    startObject(imageNumber);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpeg.byteLength} >>\nstream\n`
    );
    push(jpeg);
    push("\nendstream\nendobj\n");
  });

  const xrefPosition = position;
  push(`xref\n0 ${totalObjects + 1}\n`);
  push("0000000000 65535 f \n");
  for (let number = 1; number <= totalObjects; number += 1) {
    const offset = offsetByNumber.get(number);
    if (offset === undefined) throw new Error(`PDF object ${number} was never written`);
    push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info << /Producer (guruguru) >> >>\n` +
    `startxref\n${xrefPosition}\n%%EOF\n`
  );

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

/** `/export-images` の `format: "pdf"` 経路。ページは既に JPEG 化されたものを受け取る。 */
export async function createPdfExport(
  filenameBase: string,
  jpegPages: ReadonlyArray<Uint8Array>,
  tempDir: string,
  metrics: FileExportMetrics
): Promise<FileExportResult> {
  const pdf = buildPdf(jpegPages);
  const path = join(tempDir, "export.pdf");
  await writeFile(path, pdf, { flag: "wx" });
  return finalizeFileExport(
    {
      filename: `${filenameBase}.pdf`,
      contentType: "application/pdf",
      artifactPath: path,
      pageCount: jpegPages.length,
      metrics
    },
    "PDF の書き出し結果が空です。"
  );
}
