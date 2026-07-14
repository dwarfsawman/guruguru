/** Book の大量ページ一覧で、表示範囲付近の画像だけを読み込む。 */
import { registerEventBinder } from "./actionRegistry";

const LAZY_IMAGE_SELECTOR = "img[data-lazy-src]";

function bindLazyImages(app: HTMLElement): void {
  const load = (image: HTMLImageElement) => {
    const source = image.dataset.lazySrc;
    if (!source || image.getAttribute("src") === source) {
      return;
    }
    image.src = source;
  };

  let intersection: IntersectionObserver | null = null;
  if ("IntersectionObserver" in window) {
    intersection = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue;
            }
            const image = entry.target as HTMLImageElement;
            intersection?.unobserve(image);
            load(image);
          }
        },
        { rootMargin: "1200px 0px" }
      );
  }

  const observe = (image: HTMLImageElement) => {
    const source = image.dataset.lazySrc;
    if (!source || image.getAttribute("src") === source) {
      intersection?.unobserve(image);
      return;
    }
    if (intersection) {
      intersection.observe(image);
    } else {
      load(image);
    }
  };

  const scan = (root: ParentNode) => {
    if (root instanceof HTMLImageElement && root.matches(LAZY_IMAGE_SELECTOR)) {
      observe(root);
    }
    for (const image of root.querySelectorAll<HTMLImageElement>(LAZY_IMAGE_SELECTOR)) {
      observe(image);
    }
  };

  const unobserve = (root: ParentNode) => {
    if (!intersection) {
      return;
    }
    if (root instanceof HTMLImageElement && root.matches(LAZY_IMAGE_SELECTOR)) {
      intersection.unobserve(root);
    }
    for (const image of root.querySelectorAll<HTMLImageElement>(LAZY_IMAGE_SELECTOR)) {
      intersection.unobserve(image);
    }
  };

  scan(app);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
        observe(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          scan(node);
        }
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof Element) {
          unobserve(node);
        }
      }
    }
  }).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-lazy-src"] });
}

registerEventBinder(bindLazyImages);
