/**
 * 人間ゲートのコマ割り修正ステージ(ネームスタジオ内)。
 *
 * 編集ドラフト(state.nameLayoutEdit.draftLayout)を SVG で描画し、
 * - 辺: ドラッグで法線方向へ平行移動(共有辺=ガター境界はハンドルで両側追随)
 * - 辺中点の「+」: 頂点追加 / 頂点: ドラッグ移動
 * - 交差点ハンドル: 集まった角を一括移動
 * - 境界ハンドル: 境界の移動(◆)とガター幅の詰め/広げ(⇔)
 * - 外周辺: 余白帯へ出すと半透明プレビュー→離すと裁ち切りへスナップ
 * - 吹き出しマーカー: ドラッグで配置ヒント
 * を data-nle-* 属性でコントローラ(nameLayoutEditController)へ委譲する。
 * lightbox のコマ枠編集(pagePanelLightboxView)と同じ scale(1000) g 規約を使う。
 */
import {
  detectJunctions,
  detectSharedBoundaries,
  type SharedBoundary
} from "../../shared/nameLayoutEdit";
import { panelBounds, type PageLayout } from "../../shared/pageLayout";
import { orderPanelsByReadingDirection } from "../../shared/dialogueAutoLayout";
import type { ScriptMangaPagePlan } from "../../shared/scriptMangaPlan";
import type { DialogueLine } from "../../shared/apiTypes";
import type { NameLayoutEditState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";

const VIEWBOX_SCALE = 1000;

const VERTEX_RADIUS = 0.011;
const INSERT_RADIUS = 0.0075;
const BOUNDARY_HANDLE_RADIUS = 0.017;
const JUNCTION_HANDLE_RADIUS = 0.015;
const BALLOON_RX = 0.05;
const BALLOON_RY = 0.034;

function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

interface EdgeKey {
  panelIndex: number;
  edgeIndex: number;
}

function previewEdgeSet(edit: NameLayoutEditState): Set<string> {
  const keys = new Set<string>();
  const preview = edit.preview;
  if (!preview) return keys;
  if (preview.kind === "bleed") {
    keys.add(`${preview.panelIndex}:${preview.edgeIndex}`);
    return keys;
  }
  for (const edge of preview.edges) keys.add(`${edge.panelIndex}:${edge.edgeIndex}`);
  return keys;
}

function renderPanel(
  layout: PageLayout,
  panelIndex: number,
  previewEdges: Set<string>
): string {
  const panel = layout.panels[panelIndex]!;
  if (panel.shape.type !== "polygon") return "";
  const points = panel.shape.points;
  const pointsAttr = points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  const parts: string[] = [
    `<polygon class="nle-panel-fill" points="${pointsAttr}" data-nle-panel="${panelIndex}" />`
  ];
  const n = points.length;
  for (let edgeIndex = 0; edgeIndex < n; edgeIndex += 1) {
    const [x1, y1] = points[edgeIndex]!;
    const [x2, y2] = points[(edgeIndex + 1) % n]!;
    const preview = previewEdges.has(`${panelIndex}:${edgeIndex}`);
    parts.push(
      `<line class="nle-edge${preview ? " is-preview" : ""}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" />`,
      `<line class="nle-edge-hit" data-nle-edge="${panelIndex}:${edgeIndex}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" />`
    );
  }
  return parts.join("");
}

function renderVertexHandles(layout: PageLayout): string {
  const parts: string[] = [];
  layout.panels.forEach((panel, panelIndex) => {
    if (panel.shape.type !== "polygon") return;
    const points = panel.shape.points;
    const n = points.length;
    for (let edgeIndex = 0; edgeIndex < n; edgeIndex += 1) {
      const [x1, y1] = points[edgeIndex]!;
      const [x2, y2] = points[(edgeIndex + 1) % n]!;
      parts.push(
        `<circle class="nle-insert-handle" data-nle-insert="${panelIndex}:${edgeIndex}" cx="${num((x1 + x2) / 2)}" cy="${num((y1 + y2) / 2)}" r="${num(INSERT_RADIUS)}"><title>頂点を追加</title></circle>`
      );
    }
    points.forEach(([x, y], vertexIndex) => {
      parts.push(
        `<circle class="nle-vertex-handle" data-nle-vertex="${panelIndex}:${vertexIndex}" cx="${num(x)}" cy="${num(y)}" r="${num(VERTEX_RADIUS)}" />`
      );
    });
  });
  return parts.join("");
}

function boundaryHandles(boundary: SharedBoundary): string {
  const [cx, cy] = boundary.center;
  const dirX = boundary.end[0] - boundary.start[0];
  const dirY = boundary.end[1] - boundary.start[1];
  const id = escapeAttr(boundary.id);
  const r = BOUNDARY_HANDLE_RADIUS;
  // ◆(ひし形)=境界移動、⇔(法線方向の両矢印)=ガター幅。形で役割が分かるようにする。
  const diamond = `M ${num(cx)} ${num(cy - r)} L ${num(cx + r)} ${num(cy)} L ${num(cx)} ${num(cy + r)} L ${num(cx - r)} ${num(cy)} Z`;
  const gx = cx + dirX * 0.3;
  const gy = cy + dirY * 0.3;
  const angle = (Math.atan2(boundary.normal[1], boundary.normal[0]) * 180) / Math.PI;
  return `
    <line class="nle-boundary-line" x1="${num(boundary.start[0])}" y1="${num(boundary.start[1])}" x2="${num(boundary.end[0])}" y2="${num(boundary.end[1])}" />
    <path class="nle-boundary-handle" data-nle-boundary="${id}" d="${diamond}"><title>境界を移動(両側が追随)</title></path>
    <g class="nle-gutter-arrow" transform="rotate(${num(angle)} ${num(gx)} ${num(gy)})">
      <circle class="nle-gutter-hit" data-nle-gutter="${id}" cx="${num(gx)}" cy="${num(gy)}" r="${num(r)}"><title>コマ間の余白を詰める/広げる</title></circle>
      <line class="nle-gutter-shaft" x1="${num(gx - r * 0.8)}" y1="${num(gy)}" x2="${num(gx + r * 0.8)}" y2="${num(gy)}" />
      <path class="nle-gutter-head" d="M ${num(gx - r * 0.8)} ${num(gy)} l ${num(r * 0.4)} ${num(-r * 0.35)} M ${num(gx - r * 0.8)} ${num(gy)} l ${num(r * 0.4)} ${num(r * 0.35)} M ${num(gx + r * 0.8)} ${num(gy)} l ${num(-r * 0.4)} ${num(-r * 0.35)} M ${num(gx + r * 0.8)} ${num(gy)} l ${num(-r * 0.4)} ${num(r * 0.35)}" />
    </g>`;
}

function junctionHandles(layout: PageLayout): string {
  return detectJunctions(layout)
    .map(
      (junction) =>
        `<circle class="nle-junction-handle" data-nle-junction="${escapeAttr(junction.id)}" cx="${num(junction.position[0])}" cy="${num(junction.position[1])}" r="${num(JUNCTION_HANDLE_RADIUS)}"><title>交差点(接続する全コマの角)を移動</title></circle>`
    )
    .join("");
}

/** ページ上の台詞 orderIndex 毎の吹き出しマーカー位置(ヒントが無ければコマ内の既定位置)。 */
export function balloonMarkerPositions(
  layout: PageLayout,
  page: ScriptMangaPagePlan,
  hints: Record<number, { x: number; y: number }>
): Array<{ orderIndex: number; x: number; y: number; hinted: boolean }> {
  const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const markers: Array<{ orderIndex: number; x: number; y: number; hinted: boolean }> = [];
  page.panels.forEach((panel, slotIndex) => {
    const slot = ordered[slotIndex];
    if (!slot) return;
    const [x0, y0, x1, y1] = panelBounds(slot.shape);
    const count = panel.dialogueOrderIndexes.length;
    panel.dialogueOrderIndexes.forEach((orderIndex, indexInPanel) => {
      const hint = hints[orderIndex];
      if (hint) {
        markers.push({ orderIndex, x: hint.x, y: hint.y, hinted: true });
        return;
      }
      // 既定はコマ上部を読み順(rtl=右→左)に並べる。ソルバーの上部優先と同じ気分の初期位置。
      const t = count > 1 ? indexInPanel / (count - 1) : 0.5;
      const rtl = layout.readingDirection === "rtl";
      const x = x0 + (x1 - x0) * (rtl ? 0.82 - 0.64 * t : 0.18 + 0.64 * t);
      const y = y0 + (y1 - y0) * 0.22;
      markers.push({ orderIndex, x, y, hinted: false });
    });
  });
  return markers;
}

function renderBalloonMarkers(
  layout: PageLayout,
  page: ScriptMangaPagePlan,
  hints: Record<number, { x: number; y: number }>,
  dialogueLines: readonly DialogueLine[] | undefined
): string {
  const byOrder = new Map((dialogueLines ?? []).map((line) => [line.orderIndex, line]));
  return balloonMarkerPositions(layout, page, hints)
    .map(({ orderIndex, x, y, hinted }) => {
      const line = byOrder.get(orderIndex);
      const label = line?.speakerLabel ? `${line.speakerLabel}: ${line.text}` : line?.text ?? `台詞 ${orderIndex}`;
      return `
        <g class="nle-balloon${hinted ? " is-hinted" : ""}" data-nle-balloon="${orderIndex}">
          <ellipse cx="${num(x)}" cy="${num(y)}" rx="${num(BALLOON_RX)}" ry="${num(BALLOON_RY)}">
            <title>${escapeHtml(label)}</title>
          </ellipse>
          <text x="${num(x)}" y="${num(y + 0.012)}" text-anchor="middle">${orderIndex}</text>
        </g>`;
    })
    .join("");
}

/** 編集ステージ本体(.studio-page 内へ差し込む SVG)。 */
export function renderNameLayoutEditSvg(
  edit: NameLayoutEditState,
  page: ScriptMangaPagePlan,
  dialogueLines: readonly DialogueLine[] | undefined,
  margin: number
): string {
  const layout = edit.draftLayout;
  const height = layout.page.height;
  const previewEdges = previewEdgeSet(edit);
  const boundaries = detectSharedBoundaries(layout);
  const panels = layout.panels.map((_, index) => renderPanel(layout, index, previewEdges)).join("");
  return `
    <svg class="nle-stage" viewBox="0 0 ${VIEWBOX_SCALE} ${num(height * VIEWBOX_SCALE)}"
      xmlns="http://www.w3.org/2000/svg" data-nle-stage="1" role="application"
      aria-label="コマ割り編集ステージ">
      <g id="nameLayoutEditRoot" transform="scale(${VIEWBOX_SCALE})">
        <rect class="nle-paper" x="0" y="0" width="1" height="${num(height)}" data-nle-background="1" />
        <rect class="nle-margin-guide" x="${num(margin)}" y="${num(margin)}"
          width="${num(1 - margin * 2)}" height="${num(height - margin * 2)}" />
        ${panels}
        ${boundaries.map((boundary) => boundaryHandles(boundary)).join("")}
        ${junctionHandles(layout)}
        ${renderVertexHandles(layout)}
        ${renderBalloonMarkers(layout, page, edit.draftHints, dialogueLines)}
      </g>
    </svg>`;
}

/** 編集ツールバー(保存・取消・リセット・検証エラー)。 */
export function renderNameLayoutEditToolbar(edit: NameLayoutEditState): string {
  const invalid = edit.issues.length > 0;
  return `
    <div class="nle-toolbar">
      <p class="studio-inspector-hint nle-hint">
        辺=法線方向へドラッグ / ◆=境界を移動 / ⇔=余白を詰め広げ / ●=交差点を一括移動 /
        ＋=頂点追加 / 外周辺を余白外へ出すと裁ち切り(半透明プレビュー) / 楕円=吹き出し位置
      </p>
      ${invalid
        ? `<p class="nle-issues">${edit.issues.map((issue) => escapeHtml(issue)).join("<br />")}</p>`
        : ""}
      <div class="studio-actions nle-actions">
        <button type="button" class="button-primary compact" data-action="studio-layout-save"
          ${invalid || edit.saveBusy ? "disabled" : ""}>${edit.saveBusy ? "保存中…" : "修正を保存"}</button>
        <button type="button" class="button-secondary compact" data-action="studio-layout-undo"
          title="元に戻す (Ctrl+Z)" ${edit.canUndo ? "" : "disabled"}>↩ 元に戻す</button>
        <button type="button" class="button-secondary compact" data-action="studio-layout-redo"
          title="やり直す (Ctrl+Shift+Z)" ${edit.canRedo ? "" : "disabled"}>↪ やり直す</button>
        <button type="button" class="button-secondary compact" data-action="studio-layout-revert">編集をやり直す</button>
        <button type="button" class="button-secondary compact" data-action="studio-layout-reset"
          ${edit.saveBusy ? "disabled" : ""}>テンプレへ戻す</button>
        <button type="button" class="button-secondary compact" data-action="studio-layout-cancel">閉じる</button>
      </div>
    </div>`;
}
