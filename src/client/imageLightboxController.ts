/**
 * 汎用の画像 lightbox。`data-image-zoom-src` を持つ要素のクリックで、その画像を全画面オーバーレイ
 * で拡大表示する。オーバーレイ / ×ボタン / Escape のいずれでも閉じる。render を経ない直接 DOM 操作
 * (edgePopoutController と同様の方針)。オーバーレイは document.body 直下に作るため、アプリの
 * 再レンダー(app の innerHTML 差し替え)で消えない。サイドバーの顔参照画像プレビュー等が利用する。
 */
import { actionHandlerFor, registerEventBinder } from "./actionRegistry";
import { escapeAttr, escapeHtml } from "./format";

let overlayEl: HTMLElement | null = null;

/** 拡大画面の下部に出すアクションボタン(例: ページの生成画面へ遷移する「画像生成」)。 */
interface LightboxAction {
  /** actionRegistry に登録済みの data-action 名。 */
  name: string;
  /** action へ渡す id(例: pageId)。 */
  id: string;
  /** ボタン表示ラベル。 */
  label: string;
}

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

function openLightbox(src: string, label: string, action: LightboxAction | null) {
  closeLightbox();
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label ? `${label} 拡大表示` : "画像拡大表示");
  const actionHtml = action
    ? `<div class="image-lightbox-actions"><button class="image-lightbox-action button-secondary" type="button">${escapeHtml(action.label)}</button></div>`
    : "";
  overlay.innerHTML = `
    <img class="image-lightbox-img" src="${escapeAttr(src)}" alt="${escapeAttr(label)}" />
    ${actionHtml}
    <button class="image-lightbox-close" type="button" aria-label="閉じる">✕</button>
  `;
  // オーバーレイ内のどこをクリックしても閉じる(画像・×ボタンを含む)。
  overlay.addEventListener("click", () => closeLightbox());
  // アクションボタンは「閉じる + 登録済み action を dispatch」する。lightbox は #app の外(body 直下)に
  // 作るため main.ts の委譲クリックには乗らない。ここで actionRegistry を直接叩いて遷移させる。
  if (action) {
    const actionBtn = overlay.querySelector<HTMLElement>(".image-lightbox-action");
    actionBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      const handler = actionHandlerFor(action.name);
      closeLightbox();
      void handler?.(action.id, actionBtn);
    });
  }
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
    // トリガーに data-image-zoom-action(+ -id / -label)があれば拡大画面にアクションボタンを出す。
    const actionName = trigger?.dataset.imageZoomAction;
    const actionLabel = trigger?.dataset.imageZoomActionLabel;
    const action: LightboxAction | null = actionName && actionLabel
      ? { name: actionName, id: trigger?.dataset.imageZoomActionId ?? "", label: actionLabel }
      : null;
    openLightbox(src, trigger?.dataset.imageZoomLabel ?? "", action);
  });
}

registerEventBinder(bindImageLightbox);
