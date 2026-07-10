/**
 * 完成品の画像一括書き出し(Docs/Feature-CGCollectionSuite.md P4)ダイアログの controller。
 * 開閉・フォーム値の読み取り(`readForm`)・fetch → blob ダウンロードを扱う。ダウンロード部分は
 * openraster-export の既存導線(`bookController.ts` の `exportOpenRaster`)と同型で、
 * `downloadUtils.ts` の `responseErrorMessage`/`filenameFromContentDisposition`/`downloadBlob`
 * を共用する(bookController との循環 import を避けるため、この3関数は downloadUtils 側に切り出してある)。
 * data-action は `registerActions`、フォーム内の非 click イベント(JPEG品質行の表示切替・
 * 解像度プリセット)は `registerEventBinder` で登録する(AGENTS.md 規約)。
 *
 * format は "png" | "jpeg" | "pptx"(Docs/Feature-PptxExport.md)。PPTX 埋め込みは PNG なので
 * 品質行(JPEG品質)は format="jpeg" のときだけ表示する。既定は "png" のため、モーダル初期表示では
 * 品質行は hidden のまま。
 */
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { readForm } from "./formUtils";
import { downloadBlob, filenameFromContentDisposition, responseErrorMessage } from "./downloadUtils";

/** ダイアログを開く。pageIds が null なら全ページ、配列なら選択ページ(選択モードから)対象。 */
export function openImageExport(pageIds: string[] | null) {
  if (!state.book) {
    return;
  }
  if (pageIds && pageIds.length === 0) {
    pushToast("書き出すページを選択してください。", "error");
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

function readImageExportFormat(value: unknown): "png" | "jpeg" | "pptx" {
  if (value === "jpeg" || value === "pptx") {
    return value;
  }
  return "png";
}

function fallbackImageExportName(format: "png" | "jpeg" | "pptx", blobType: string): string {
  if (format === "pptx") {
    return "guruguru-book.pptx";
  }
  if (blobType === "application/zip") {
    return "guruguru-images.zip";
  }
  return format === "jpeg" ? "page.jpg" : "page.png";
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
    const response = await fetch(`/api/projects/${state.currentProjectId}/export-images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds, format, quality, pixelWidth })
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const blob = await response.blob();
    const fallbackName = fallbackImageExportName(format, blob.type);
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    downloadBlob(blob, filename);
    if (format === "pptx") {
      pushToast("PPTXを書き出しました。", "info");
    } else {
      pushToast(pageIds && pageIds.length === 1 ? "ページを画像として書き出しました。" : "画像を書き出しました。", "info");
    }
    state.imageExportOpen = false;
    state.imageExportPageIds = null;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.imageExportBusy = false;
    requestRender();
  }
}

/** JPEG 選択時だけ品質スライダー行を表示する(PPTX 埋め込みは PNG のため対象外。state を介さない純 DOM 操作)。 */
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
  });
}

registerActions({
  "close-image-export": () => closeImageExport(),
  "submit-image-export": () => submitImageExport(),
  "set-image-export-width": (id) => setImageExportWidthPreset(id)
});

registerEventBinder(bindImageExportEvents);
