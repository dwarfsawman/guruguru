/**
 * サーバー起動時の環境変数解決を1箇所へ集約した型付きリゾルバ。
 *
 * 重要な不変条件: **テストモード(GURUGURU_TEST_DB=1 か NODE_ENV=test)では、テスト用
 * データディレクトリが必ず勝つ**。シェルから GURUGURU_DATA_DIR を継承したままテストを
 * 実行しても、本番の data dir / DB を開いてしまうことがないようにする(旧実装は
 * GURUGURU_DATA_DIR をテストモードより先に評価していたため、この事故が起こり得た)。
 * 開発/本番(非テストモード)の優先順位は従来どおり:
 *   GURUGURU_DATA_DIR → OS 別のユーザーデータ既定位置。
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type InstanceMode = "test" | "agent" | "user";

export interface ServerEnvironment {
  /** GURUGURU_TEST_DB=1 または NODE_ENV=test。 */
  isTestDataMode: boolean;
  /** test はテストモード固定。agent は GURUGURU_INSTANCE_MODE=agent、それ以外は user。 */
  instanceMode: InstanceMode;
  /** DB とプロジェクトストレージのルートディレクトリ(resolve 済み絶対パス)。 */
  dataRoot: string;
  /** ComfyUI 既定接続先(GURUGURU_DEFAULT_COMFY_BASE_URL)。 */
  defaultComfyBaseUrl: string;
  /** ComfyUI 既定 WebSocket 接続先(GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL)。 */
  defaultComfyWebsocketUrl: string;
}

export function resolveServerEnvironment(env: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  const isTestDataMode = env.GURUGURU_TEST_DB === "1" || env.NODE_ENV === "test";
  const instanceMode: InstanceMode = isTestDataMode ? "test" : env.GURUGURU_INSTANCE_MODE === "agent" ? "agent" : "user";
  return {
    isTestDataMode,
    instanceMode,
    dataRoot: resolveDataRoot(env, isTestDataMode),
    defaultComfyBaseUrl: env.GURUGURU_DEFAULT_COMFY_BASE_URL?.trim() || "http://127.0.0.1:8188",
    defaultComfyWebsocketUrl: env.GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL?.trim() || "ws://127.0.0.1:8188/ws"
  };
}

function resolveDataRoot(env: NodeJS.ProcessEnv, isTestDataMode: boolean): string {
  // テストモードはテスト用ディレクトリが GURUGURU_DATA_DIR より必ず優先(ファイルヘッダ参照)。
  if (isTestDataMode) {
    return resolve(env.GURUGURU_TEST_DATA_DIR?.trim() || join(tmpdir(), "guruguru-test", `pid-${process.pid}`));
  }

  const explicitDataDir = env.GURUGURU_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolve(explicitDataDir);
  }

  return defaultUserDataRoot(env);
}

function defaultUserDataRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "GURUGURU");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "GURUGURU");
  }

  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "guruguru");
}
