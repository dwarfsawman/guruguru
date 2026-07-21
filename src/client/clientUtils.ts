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
