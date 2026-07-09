/**
 * fetch → blob ダウンロードの共通ヘルパ。OpenRaster エクスポート(`bookController.ts`)と
 * 画像一括書き出し(`imageExportController.ts`、Docs/Feature-CGCollectionSuite.md P4)の
 * どちらも同じ「fetch → blob → `<a download>`」導線を使うため、両者からの循環 import を避けて
 * ここに切り出す。
 */

/** fetch のエラーレスポンスから表示用メッセージを取り出す。 */
export async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = await response.json() as { error?: string };
    return parsed.error || `${response.status} ${response.statusText}`.trim();
  } catch {
    return `${response.status} ${response.statusText}`.trim();
  }
}

/** Content-Disposition ヘッダからファイル名を取り出す(取得できなければ null)。 */
export function filenameFromContentDisposition(value: string | null): string | null {
  const match = value?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

/** blob を `<a download>` 経由で保存する。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
