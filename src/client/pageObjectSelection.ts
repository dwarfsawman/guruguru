/**
 * ページオブジェクトの複数選択・グループ化(Docs/Feature-PageEditSidebarUx.md 課題C)の純ロジック。
 * DOM・state 非依存(`pageObjectHistory.ts` と同じ方針)。`pageObjectsController.ts` が紙面ドラッグ・
 * レイヤ一覧クリックの両方から共通で呼ぶ -- 選択集合の解決規則(通常/Shift/Alt クリック)が
 * ステージとレイヤ一覧で食い違わないよう、判定ロジックをここへ一本化してテスト可能にする。
 */
import type { PageObject, PageVec } from "../shared/pageObjects";

export interface PageObjectSelectionModifiers {
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * id と同じ groupId を持つ全メンバー id。id 自身を先頭にする(クリックした本人が selectedPageObjectIds の
 * 先頭=primary になるようにするため)。対象が見つからない/groupId 未設定なら [id] だけを返す。
 */
export function groupMembersOf(objects: readonly PageObject[], id: string): string[] {
  const target = objects.find((object) => object.id === id);
  const groupId = target?.groupId;
  if (!groupId) {
    return [id];
  }
  const others = objects.filter((object) => object.groupId === groupId && object.id !== id).map((object) => object.id);
  return [id, ...others];
}

/** 2つの選択 id 配列が(順序含め)同一か。無駄な flush/再描画/履歴コミットを避ける差分判定に使う。 */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 紙面(ステージ)・レイヤ一覧共通のクリック選択解決(C-2)。
 * - 通常クリック: 対象(グループ所属ならグループ全員)だけを選択する(クリックした本人が先頭=primary)。
 * - Shift+クリック: 対象(グループ単位)を選択集合へトグルする(グループの一部だけが選択済みの場合は
 *   「まだ選択されていないメンバーを追加」= 全員選択済みの時だけ「グループごと除外」)。
 *   既存の並び順は保持し、新規追加分は末尾に足す(先頭 = 最初に選んだ primary のまま動かさない)。
 * - Alt+クリック: グループを無視してクリックした1個だけを選択する(グループ内個別編集の逃げ道)。
 */
export function resolvePageObjectSelectionClick(
  objects: readonly PageObject[],
  current: readonly string[],
  clickedId: string,
  modifiers: PageObjectSelectionModifiers
): string[] {
  if (modifiers.altKey) {
    return [clickedId];
  }
  const targets = groupMembersOf(objects, clickedId);
  if (!modifiers.shiftKey) {
    return targets;
  }
  const currentSet = new Set(current);
  const allSelected = targets.every((id) => currentSet.has(id));
  if (allSelected) {
    const targetSet = new Set(targets);
    return current.filter((id) => !targetSet.has(id));
  }
  const next = [...current];
  for (const id of targets) {
    if (!currentSet.has(id)) {
      next.push(id);
    }
  }
  return next;
}

/** 「グループ化」(C-4): 選択中の全オブジェクトへ新規 groupId を割り当てる(既存グループ混在は新IDへ結合)。 */
export function applyGroupId(objects: readonly PageObject[], selectedIds: readonly string[], groupId: string): PageObject[] {
  const idSet = new Set(selectedIds);
  return objects.map((object) => (idSet.has(object.id) ? ({ ...object, groupId } as PageObject) : object));
}

/** 「グループ解除」(C-4): 選択中オブジェクトの groupId キー自体を外す(空文字ではなくキー無しにする)。 */
export function clearGroupId(objects: readonly PageObject[], selectedIds: readonly string[]): PageObject[] {
  const idSet = new Set(selectedIds);
  return objects.map((object) => {
    if (!idSet.has(object.id) || object.groupId === undefined) {
      return object;
    }
    const { groupId: _groupId, ...rest } = object;
    return rest as PageObject;
  });
}

/**
 * 複数選択の移動(C-3): ドラッグ開始時点の位置スナップショット(startObjects)を基準に、全員へ同じ
 * delta(dx, dy)を適用する。`objects`(現在の draft)側の他フィールドは保ち、position だけ
 * `start.position + delta` へ差し替える -- 途中経過を積み上げず常に開始位置からの絶対 delta を
 * 適用するので、pointermove を何度呼んでも誤差が蓄積しない。単一選択の移動も startObjects が
 * 1件だけの配列として渡せば同じ経路で処理できる。
 */
export function applyGroupMoveDelta<T extends { id: string; position: PageVec }>(
  objects: readonly T[],
  startObjects: readonly T[],
  dx: number,
  dy: number
): T[] {
  const startById = new Map(startObjects.map((object) => [object.id, object]));
  return objects.map((object) => {
    const start = startById.get(object.id);
    return start ? { ...object, position: { x: start.position.x + dx, y: start.position.y + dy } } : object;
  });
}
