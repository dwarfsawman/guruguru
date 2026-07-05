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
import { isPathInside } from "./paths";

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
 * スナップショットが参照するアセット画像/サムネイルファイルを削除する。
 * discard(削除の確定)専用 — restore 後は呼ばないこと。
 * 安全のため dataRoot 配下のパスのみ対象にする。
 */
function deleteSnapshotAssetFiles(snapshot: RoundTreeSnapshot) {
  for (const asset of snapshot.assets) {
    for (const field of ["image_path", "thumbnail_small_path", "thumbnail_medium_path"] as const) {
      const filePath = asset[field];
      if (typeof filePath !== "string" || !filePath.trim() || !isPathInside(filePath, dataRoot)) {
        continue;
      }
      try {
        rmSync(filePath, { force: true });
      } catch {
        // ファイル削除の失敗で破棄全体を止めない。
      }
    }
  }
}

/**
 * 削除の確定: スナップショットが参照する画像ファイルを削除してから
 * スナップショット自体を破棄する(以後復元不能)。
 */
export function discardRoundTrashSnapshot(rootId: string) {
  const snapshot = readRoundTrashSnapshot(rootId);
  if (snapshot) {
    deleteSnapshotAssetFiles(snapshot);
  }
  removeRoundTrashSnapshot(rootId);
}

/**
 * ゴミ箱スナップショットを全破棄する(参照画像ファイルも削除)。サーバー起動時に一度呼ぶ。
 * ブラウザやサーバーの強制終了で discard されずに残った分の後始末で、前回セッションの
 * undo 履歴はクライアント側に残っていないため残骸でしかない。
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
      discardRoundTrashSnapshot(entry.slice(0, -".json".length));
      purged += 1;
    } catch {
      // 個別ファイルの失敗はパージ全体を止めない。
    }
  }
  return purged;
}
