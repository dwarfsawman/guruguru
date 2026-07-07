/**
 * 汎用の画像 lightbox。`data-image-zoom-src` を持つ要素のクリックで、その画像を全画面オーバーレイ
 * で拡大表示する。オーバーレイ / ×ボタン / Escape のいずれでも閉じる。render を経ない直接 DOM 操作
 * (edgePopoutController と同様の方針)。オーバーレイは document.body 直下に作るため、アプリの
 * 再レンダー(app の innerHTML 差し替え)で消えない。サイドバーの顔参照画像プレビュー等が利用する。
 */
import { registerEventBinder } from "./actionRegistry";
import { escapeAttr } from "./format";

let overlayEl: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeLightbox();
  }
}

function closeLightbox() {
  if (!overlayEl) {
    return;
  }
  overlayEl.remove();
  overlayEl = null;
  document.removeEventListener("keydown", onKeydown);
}

function openLightbox(src: string, label: string) {
  closeLightbox();
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label ? `${label} 拡大表示` : "画像拡大表示");
  overlay.innerHTML = `
    <img class="image-lightbox-img" src="${escapeAttr(src)}" alt="${escapeAttr(label)}" />
    <button class="image-lightbox-close" type="button" aria-label="閉じる">✕</button>
  `;
  // オーバーレイ内のどこをクリックしても閉じる(画像・×ボタンを含む)。
  overlay.addEventListener("click", () => closeLightbox());
  document.body.appendChild(overlay);
  overlayEl = overlay;
  document.addEventListener("keydown", onKeydown);
}

function bindImageLightbox(app: HTMLElement) {
  app.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-image-zoom-src]")
      : null;
    const src = trigger?.dataset.imageZoomSrc;
    if (!src) {
      return;
    }
    event.preventDefault();
    openLightbox(src, trigger?.dataset.imageZoomLabel ?? "");
  });
}

registerEventBinder(bindImageLightbox);
