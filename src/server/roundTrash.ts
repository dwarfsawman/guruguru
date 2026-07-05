/**
 * Round 削除のゴミ箱(UX改善#3)。
 *
 * DELETE はサブツリーの関連行(rounds / jobs / assets / asset_parents / selection_events)を
 * JSON スナップショットとして `<dataRoot>/trash/rounds/<rootRoundId>.json` に書き出してから
 * DB から完全削除する。restore はスナップショットを再 INSERT して復元する。
 * DB 本体には削除済み行が残らないため、表示系クエリにフィルタは不要。
 *
 * 画像ファイルは削除時も disk に残す(従来の完全削除と同じ挙動)。
 * undo できるのはプロジェクトを開いている間だけ: クライアントはプロジェクトを離れる時に
 * discard を呼んでスナップショットを破棄し、ブラウザごと閉じられた等の残骸は
 * サーバー起動時の全パージで消える。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./db";

const trashDir = join(dataRoot, "trash", "rounds");

export type SqlRow = Record<string, unknown>;

export type RoundTreeSnapshot = {
  version: 1;
  rootId: string;
  deletedAt: string;
  /** 親が先になる順(復元時にこの順で INSERT する)。 */
  rounds: SqlRow[];
  jobs: SqlRow[];
  assets: SqlRow[];
  assetParents: SqlRow[];
  selectionEvents: SqlRow[];
};

function snapshotPath(rootId: string) {
  // rootId は createId 由来(英数と _ -)のみを許すことでパストラバーサルを防ぐ。
  if (!/^[\w-]+$/.test(rootId)) {
    throw new Error(`Invalid round id for trash snapshot: ${rootId}`);
  }
  return join(trashDir, `${rootId}.json`);
}

export function writeRoundTrashSnapshot(snapshot: RoundTreeSnapshot) {
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(snapshotPath(snapshot.rootId), JSON.stringify(snapshot), "utf8");
}

export function readRoundTrashSnapshot(rootId: string): RoundTreeSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath(rootId), "utf8")) as RoundTreeSnapshot;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function removeRoundTrashSnapshot(rootId: string) {
  rmSync(snapshotPath(rootId), { force: true });
}

/**
 * ゴミ箱スナップショットを全削除する。サーバー起動時に一度呼ぶ
 * (前回セッションの undo 履歴はクライアント側に残っていないため、残骸でしかない)。
 */
export function purgeAllRoundTrash() {
  let entries: string[];
  try {
    entries = readdirSync(trashDir);
  } catch {
    return 0;
  }
  let purged = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      rmSync(join(trashDir, entry), { force: true });
      purged += 1;
    } catch {
      // 個別ファイルの失敗はパージ全体を止めない。
    }
  }
  return purged;
}
