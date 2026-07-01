export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttr(value: unknown) {
  return escapeHtml(value).replaceAll("'", "&#039;");
}

export function formatDate(value: string) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

export function formatCssNumber(value: number) {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

export function formatSliderValue(input: HTMLInputElement) {
  const step = Number(input.step || 1);
  const value = Number(input.value);
  return step < 1 ? value.toFixed(2).replace(/0$/, "") : String(value);
}
