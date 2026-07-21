import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveServerEnvironment } from "./serverEnv.ts";

const PROD_DIR = resolve(join(tmpdir(), "guruguru-serverenv-prod"));
const TEST_DIR = resolve(join(tmpdir(), "guruguru-serverenv-test"));

test("serverEnv: テストモードでは GURUGURU_DATA_DIR よりテスト用ディレクトリが必ず勝つ", () => {
  const env = resolveServerEnvironment({
    GURUGURU_TEST_DB: "1",
    GURUGURU_DATA_DIR: PROD_DIR,
    GURUGURU_TEST_DATA_DIR: TEST_DIR
  });
  assert.equal(env.isTestDataMode, true);
  assert.equal(env.instanceMode, "test");
  assert.equal(env.dataRoot, TEST_DIR);
});

test("serverEnv: テストモード + GURUGURU_TEST_DATA_DIR 未指定は tmpdir 配下(pid別)、DATA_DIR継承でも本番を開かない", () => {
  const env = resolveServerEnvironment({
    NODE_ENV: "test",
    GURUGURU_DATA_DIR: PROD_DIR
  });
  assert.equal(env.isTestDataMode, true);
  assert.equal(env.dataRoot, resolve(join(tmpdir(), "guruguru-test", `pid-${process.pid}`)));
  assert.notEqual(env.dataRoot, PROD_DIR);
});

test("serverEnv: 非テストモードは従来どおり GURUGURU_DATA_DIR が優先される", () => {
  const env = resolveServerEnvironment({
    GURUGURU_DATA_DIR: PROD_DIR,
    GURUGURU_TEST_DATA_DIR: TEST_DIR
  });
  assert.equal(env.isTestDataMode, false);
  assert.equal(env.instanceMode, "user");
  assert.equal(env.dataRoot, PROD_DIR);
});

test("serverEnv: 非テストモード + GURUGURU_DATA_DIR 未指定は OS 既定のユーザーデータ位置", () => {
  const env = resolveServerEnvironment({});
  assert.equal(env.isTestDataMode, false);
  assert.ok(env.dataRoot.length > 0);
  assert.notEqual(env.dataRoot, TEST_DIR);
  if (process.platform === "win32") {
    assert.ok(env.dataRoot.endsWith("GURUGURU"));
  }
});

test("serverEnv: GURUGURU_INSTANCE_MODE=agent は非テストモードでのみ有効", () => {
  const agent = resolveServerEnvironment({ GURUGURU_INSTANCE_MODE: "agent", GURUGURU_DATA_DIR: PROD_DIR });
  assert.equal(agent.instanceMode, "agent");

  const testWins = resolveServerEnvironment({ GURUGURU_INSTANCE_MODE: "agent", GURUGURU_TEST_DB: "1" });
  assert.equal(testWins.instanceMode, "test");
});

test("serverEnv: ComfyUI 既定接続先は環境変数で上書きでき、未指定なら 127.0.0.1:8188", () => {
  const defaults = resolveServerEnvironment({});
  assert.equal(defaults.defaultComfyBaseUrl, "http://127.0.0.1:8188");
  assert.equal(defaults.defaultComfyWebsocketUrl, "ws://127.0.0.1:8188/ws");

  const overridden = resolveServerEnvironment({
    GURUGURU_DEFAULT_COMFY_BASE_URL: " http://127.0.0.1:8288 ",
    GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL: "ws://127.0.0.1:8288/ws"
  });
  assert.equal(overridden.defaultComfyBaseUrl, "http://127.0.0.1:8288");
  assert.equal(overridden.defaultComfyWebsocketUrl, "ws://127.0.0.1:8288/ws");
});
