/** HTML/SVG 文字列生成用の最小エスケープ(client/format.ts から共有化、挙動は同一)。 */
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
