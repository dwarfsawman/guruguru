/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。ページのコマ(`PageLayout.panels[].id`)への
 * 画像割り当て/クロップを扱う。1コマにつき現在の割り当ては `page_panel_assignments` の1行
 * (page_id + panel_id ユニーク)。json5 依存の layoutTemplates.ts とは独立したモジュール。
 */
import type { PagePanelAssignment, PageRow } from "../shared/apiTypes";
import type { LayoutPanel, PanelCrop } from "../shared/pageLayout";
import { defaultCoverCrop, normalizePanelCrop, panelBounds, panelBoundsSize } from "../shared/pageLayout";
import { createId, getRow, getRows, runSql, toApiRow } from "./db";
import { HttpError } from "./http";
import { objectBody, stringOrNull } from "./validate";

function requirePanel(page: PageRow, panelId: string): LayoutPanel {
  const panel = page.layout?.panels.find((item) => item.id === panelId);
  if (!panel) {
    throw new HttpError(400, "指定されたコマ(panel)がこのページのレイアウトに見つかりません。");
  }
  return panel;
}

function decoratePanelAssignment(row: Record<string, unknown>): PagePanelAssignment {
  const api = toApiRow(row)!;
  return {
    ...api,
    assetImageUrl: `/api/assets/${api.assetId}/image`
  } as unknown as PagePanelAssignment;
}

/** ページの全コマ割り当て(`page.layout` が無いページに対して呼んでも空配列)。 */
export function listPanelAssignments(pageId: string): PagePanelAssignment[] {
  const rows = getRows<Record<string, unknown>>(
    `SELECT ppa.*, a.width AS asset_width, a.height AS asset_height
     FROM page_panel_assignments ppa
     JOIN assets a ON a.id = ppa.asset_id
     WHERE ppa.page_id = ?
     ORDER BY ppa.updated_at ASC`,
    [pageId]
  );
  return rows.map(decoratePanelAssignment);
}

/**
 * `rawCrop` があればそれを優先し、無ければ「同じ asset への再割り当て(crop 更新)」の場合のみ
 * 既存 crop を引き継ぐ。asset が変わった時は前の crop は別画像の座標系なので使わず、
 * パネル外接矩形へ cover フィットする既定 crop を計算し直す。
 */
function resolveCrop(
  rawCrop: unknown,
  reuseCropJson: string | null,
  panel: LayoutPanel,
  asset: { width: number | null; height: number | null }
): PanelCrop {
  const explicit = normalizePanelCrop(rawCrop);
  if (explicit) {
    return explicit;
  }
  if (reuseCropJson) {
    try {
      const reused = normalizePanelCrop(JSON.parse(reuseCropJson));
      if (reused) {
        return reused;
      }
    } catch {
      // 壊れた crop_json は既定値へフォールバックする。
    }
  }
  const [boxWidth, boxHeight] = panelBoundsSize(panelBounds(panel.shape));
  return defaultCoverCrop(asset.width ?? 0, asset.height ?? 0, boxWidth, boxHeight);
}

/**
 * コマへの割り当てを更新する。`body.assetId` が null/未指定なら割り当て解除(削除)。
 * `body.crop` があれば明示的に使う(ドラッグ確定時)。無ければ cover フィットの既定値
 * (新規割り当て/別 asset への差し替え時)か、既存 crop(同一 asset の再更新時)を使う。
 */
export function upsertPanelAssignment(
  page: PageRow,
  panelId: string,
  body: unknown
): { assignment: PagePanelAssignment | null; deleted: boolean } {
  const panel = requirePanel(page, panelId);
  const input = objectBody(body);
  const assetId = stringOrNull(input.assetId ?? input.asset_id);

  if (assetId === null) {
    runSql("DELETE FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?", [page.id, panelId]);
    return { assignment: null, deleted: true };
  }

  const asset = getRow<{ id: string; width: number | null; height: number | null }>(
    "SELECT id, width, height FROM assets WHERE id = ? AND project_id = ?",
    [assetId, page.projectId]
  );
  if (!asset) {
    throw new HttpError(400, "指定された画像(asset)がこのプロジェクトに見つかりません。");
  }

  const existing = getRow<{ asset_id: string; crop_json: string }>(
    "SELECT asset_id, crop_json FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?",
    [page.id, panelId]
  );
  const reuseCropJson = existing && existing.asset_id === assetId ? existing.crop_json : null;
  const crop = resolveCrop(input.crop, reuseCropJson, panel, asset);

  if (existing) {
    runSql(
      "UPDATE page_panel_assignments SET asset_id = ?, crop_json = ?, updated_at = CURRENT_TIMESTAMP WHERE page_id = ? AND panel_id = ?",
      [assetId, JSON.stringify(crop), page.id, panelId]
    );
  } else {
    runSql(
      "INSERT INTO page_panel_assignments (id, page_id, panel_id, asset_id, crop_json) VALUES (?, ?, ?, ?, ?)",
      [createId("panelassign"), page.id, panelId, assetId, JSON.stringify(crop)]
    );
  }

  const row = getRow<Record<string, unknown>>(
    `SELECT ppa.*, a.width AS asset_width, a.height AS asset_height
     FROM page_panel_assignments ppa JOIN assets a ON a.id = ppa.asset_id
     WHERE ppa.page_id = ? AND ppa.panel_id = ?`,
    [page.id, panelId]
  );
  return { assignment: row ? decoratePanelAssignment(row) : null, deleted: false };
}

/**
 * asset が「選択」状態にされた時、その生成ラウンドが特定コマ向け(target_panel_id)なら
 * そのコマへ自動割り当てる。対象外(single モード/コマ非対象の生成)なら何もしない。
 * パネルがレイアウト変更等で消えていた場合も、選択自体は失敗させたくないので黙って諦める。
 */
export function autoAssignPanelForSelectedAsset(assetId: string, roundId: string) {
  const round = getRow<{ page_id: string | null; target_panel_id: string | null }>(
    "SELECT page_id, target_panel_id FROM generation_rounds WHERE id = ?",
    [roundId]
  );
  if (!round?.page_id || !round.target_panel_id) {
    return;
  }
  const page = toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [round.page_id])) as unknown as PageRow | null;
  if (!page?.layout) {
    return;
  }
  try {
    upsertPanelAssignment(page, round.target_panel_id, { assetId });
  } catch {
    // 対象コマが見つからない等は黙って諦める(asset の選択状態自体は既に更新済み)。
  }
}
