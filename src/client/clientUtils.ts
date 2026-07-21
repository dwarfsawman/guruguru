// clampNumber は shared/numbers.ts へ統合(number 入力に対して旧ローカル実装と同一挙動)。
export { clampNumber } from "../shared/numbers";

export function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** keydown/paste 系の一元ハンドラでテキスト入力中をスキップする判定(main.ts から移設)。 */
export function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable || !!target.closest("[contenteditable=''], [contenteditable='true']");
}

/**
 * `#previewImage` 等のロード完了を待つ。morph による要素差し替えで load/error が二度と発火しない
 * ことがあるため、タイムアウト付き(既定10秒)で必ず決着させる(pose/WebSAM の検出前待ちで使用)。
 */
export function waitForImageLoad(image: HTMLImageElement, timeoutMs = 10_000): Promise<void> {
  if (image.complete && image.naturalWidth > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("画像の読み込み完了を待てませんでした。")), timeoutMs);
    image.addEventListener(
      "load",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    image.addEventListener(
      "error",
      () => {
        window.clearTimeout(timer);
        reject(new Error("画像を読み込めませんでした。"));
      },
      { once: true }
    );
  });
}

export function imageToRawData(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("画像処理Canvasを初期化できません。");
  }
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: imageData.data,
    width: canvas.width,
    height: canvas.height
  };
}
