/**
 * 完成品エクスポート(Docs/Feature-CGCollectionSuite.md P4)ダイアログの controller。
 * 開閉・フォーム値の読み取り(`readForm`)・fetch → blob ダウンロードを扱う。ダウンロード部分は
 * `downloadUtils.ts` の `responseErrorMessage`/`filenameFromContentDisposition`/`downloadBlob`
 * を共用する(bookController との循環 import を避けるため、この3関数は downloadUtils 側に切り出してある)。
 * data-action は `registerActions`、フォーム内の非 click イベント(JPEG品質行・解像度行の
 * 表示切替・解像度プリセット)は `registerEventBinder` で登録する(AGENTS.md 規約)。
 *
 * format は "png" | "jpeg" | "ora" | "pptx"。png/jpeg/pptx は `/export-images`
 * (Docs/Feature-PptxExport.md)、ora は `/openraster-export`(Docs/Reference-OpenRasterExport.md)
 * へ振り分ける -- 旧「OpenRasterでエクスポート」ボタン群はこのダイアログに統合された。
 * JPEG品質行は format="jpeg" のみ、解像度行は ORA 以外のみ表示する(ORA はレイヤー構造ごと
 * 元解像度で書き出すため)。既定は "png"。
 */
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { readForm } from "./formUtils";
import { downloadBlob, filenameFromContentDisposition, responseErrorMessage } from "./downloadUtils";

type ImageExportFormat = "png" | "jpeg" | "ora" | "pptx";

/** ダイアログを開く。pageIds が null なら全ページ、配列なら選択ページ(選択モード/ページカード)対象。 */
export function openImageExport(pageIds: string[] | null) {
  if (!state.book) {
    return;
  }
  if (pageIds && pageIds.length === 0) {
    pushToast("エクスポートするページを選択してください。", "error");
    return;
  }
  state.imageExportOpen = true;
  state.imageExportPageIds = pageIds;
  requestRender();
}

export function closeImageExport() {
  if (state.imageExportBusy) {
    return;
  }
  state.imageExportOpen = false;
  state.imageExportPageIds = null;
  requestRender();
}

function setImageExportWidthPreset(pixelWidth: string) {
  const input = document.querySelector<HTMLInputElement>('#image-export-form input[name="pixelWidth"]');
  if (input) {
    input.value = pixelWidth;
  }
}

function readImageExportFormat(value: unknown): ImageExportFormat {
  if (value === "jpeg" || value === "ora" || value === "pptx") {
    return value;
  }
  return "png";
}

function fallbackImageExportName(format: ImageExportFormat, blobType: string): string {
  if (format === "pptx") {
    return "guruguru-book.pptx";
  }
  if (format === "ora") {
    return blobType === "application/zip" ? "guruguru-openraster.zip" : "page.ora";
  }
  if (blobType === "application/zip") {
    return "guruguru-images.zip";
  }
  return format === "jpeg" ? "page.jpg" : "page.png";
}

/** format ごとのエンドポイントとリクエストボディ。ora だけ別 API(openraster-export)へ振り分ける。 */
function imageExportRequest(
  projectId: string,
  format: ImageExportFormat,
  pageIds: string[] | null,
  quality: number,
  pixelWidth: number
): { url: string; body: unknown } {
  if (format === "ora") {
    return {
      url: `/api/projects/${projectId}/openraster-export`,
      body: pageIds ? { pageIds } : {}
    };
  }
  return {
    url: `/api/projects/${projectId}/export-images`,
    body: { pageIds, format, quality, pixelWidth }
  };
}

function imageExportSuccessToast(format: ImageExportFormat, pageIds: string[] | null): string {
  if (format === "pptx") {
    return "PPTXを書き出しました。";
  }
  if (format === "ora") {
    return pageIds && pageIds.length === 1 ? "ページをOpenRasterでエクスポートしました。" : "OpenRasterを書き出しました。";
  }
  return pageIds && pageIds.length === 1 ? "ページを画像として書き出しました。" : "画像を書き出しました。";
}

async function submitImageExport() {
  if (!state.currentProjectId || state.imageExportBusy) {
    return;
  }
  const values = readForm("image-export-form");
  const format = readImageExportFormat(values.format);
  const quality = Number(values.quality) || 90;
  const pixelWidth = Number(values.pixelWidth) || 1280;
  const pageIds = state.imageExportPageIds;
  state.imageExportBusy = true;
  requestRender();
  try {
    const request = imageExportRequest(state.currentProjectId, format, pageIds, quality, pixelWidth);
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body)
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const blob = await response.blob();
    const fallbackName = fallbackImageExportName(format, blob.type);
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    downloadBlob(blob, filename);
    pushToast(imageExportSuccessToast(format, pageIds), "info");
    state.imageExportOpen = false;
    state.imageExportPageIds = null;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.imageExportBusy = false;
    requestRender();
  }
}

/**
 * format 選択に応じた行の表示切替(state を介さない純 DOM 操作)。
 * JPEG品質行は jpeg のみ、解像度行は ora 以外のみ表示する(ORA は元解像度で書き出す)。
 */
function bindImageExportEvents(app: HTMLElement) {
  app.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "format") {
      return;
    }
    const form = target.closest<HTMLFormElement>("#image-export-form");
    const qualityRow = form?.querySelector<HTMLElement>("[data-image-export-quality-row]");
    if (qualityRow) {
      qualityRow.hidden = target.value !== "jpeg";
    }
    const widthRow = form?.querySelector<HTMLElement>("[data-image-export-width-row]");
    if (widthRow) {
      widthRow.hidden = target.value === "ora";
    }
  });
}

registerActions({
  "close-image-export": () => closeImageExport(),
  "submit-image-export": () => submitImageExport(),
  "set-image-export-width": (id) => setImageExportWidthPreset(id)
});

registerEventBinder(bindImageExportEvents);
