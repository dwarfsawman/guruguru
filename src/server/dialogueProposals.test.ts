import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptDialogueProposalItems,
  createDialogueProposal,
  listDialogueProposals,
  rejectDialogueProposalItems
} from "./dialogueProposals.ts";
import { createPage, updatePageLayout } from "./pages.ts";
import { createProject } from "./projects.ts";
import { createScript, addScriptRevision } from "./scripts.ts";
import { initializeDb, getRow, setSetting } from "./db.ts";
import { HttpError } from "./http.ts";

type MockServer = ReturnType<typeof Bun.serve>;

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S4 dialogue proposals", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

function twoPanelLayout() {
  return {
    version: 1,
    page: { aspectRatio: [1, 1.4], height: 1.4 },
    readingDirection: "rtl",
    panels: [
      { id: "panel_1", order: 1, shape: { type: "rect", bounds: [0, 0, 0.5, 0.7] } },
      { id: "panel_2", order: 2, shape: { type: "rect", bounds: [0.5, 0, 1, 0.7] } }
    ]
  };
}

const SOURCE_V1 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");

function configureMockLlm(server: MockServer) {
  setSetting("llm", {
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: "mock-dialogue-model",
    systemPrompt: "",
    temperature: 0.4
  });
}

/** 太郎(panel_1)/花子(存在しない panelId)のセリフ案を返す固定モック。 */
function startFixedMockLlm(): MockServer {
  return Bun.serve({
    port: 0,
    fetch: () => {
      const content = JSON.stringify({
        items: [
          { panelId: "panel_1", speakerName: "太郎", text: "おはよう!", semanticKind: "dialogue" },
          { panelId: "panel_missing", speakerName: "花子", text: "おはよう、太郎。", semanticKind: "dialogue" }
        ]
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { "content-type": "application/json" }
      });
    }
  });
}

function startAlwaysFailingMockLlm(): MockServer {
  return Bun.serve({ port: 0, fetch: () => new Response("server error", { status: 500 }) });
}

test("createDialogueProposal: 成功時は proposed 状態で items/rawOutput/request を永続化する", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const script = createScript(projectId, { fountainSource: SOURCE_V1 });
  const server = startFixedMockLlm();
  try {
    configureMockLlm(server);
    const { proposal } = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.model, "mock-dialogue-model");
    assert.equal(proposal.scriptId, script.script.id);
    assert.equal(proposal.scriptRevisionId, script.revision.id);
    assert.equal(proposal.isStale, false);
    assert.ok(proposal.rawOutput);
    assert.ok(Array.isArray(proposal.request));
    assert.equal((proposal.request as unknown[]).length, 2, "system+user messages を保存する");
    assert.equal(proposal.items?.length, 2);
    assert.ok(proposal.items!.every((item) => item.itemStatus === "proposed"));

    // panelId の実在チェック(既知の要求: 不正な panelId は黙殺せず null に落とす)。
    const taroItem = proposal.items!.find((item) => item.speakerName === "太郎")!;
    const hanakoItem = proposal.items!.find((item) => item.speakerName === "花子")!;
    assert.equal(taroItem.panelId, "panel_1");
    assert.equal(hanakoItem.panelId, null, "layout.panels に無い panelId は null へ落とす");
  } finally {
    server.stop(true);
  }
});

test("adopt: 部分採用(1件のみ+文言修正)は items_json に項目別履歴を残し、dialogue_lines(source=llm)を作る", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const script = createScript(projectId, { fountainSource: SOURCE_V1 });
  const server = startFixedMockLlm();
  try {
    configureMockLlm(server);
    const created = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
    const proposalId = created.proposal.id;
    const taroIndex = created.proposal.items!.findIndex((item) => item.speakerName === "太郎");

    const adopted = adoptDialogueProposalItems(proposalId, {
      itemIndices: [taroIndex],
      edits: [{ index: taroIndex, text: "おはよう、今日もいい天気だね。" }]
    });
    assert.equal(adopted.lines.length, 1);
    const line = adopted.lines[0]!;
    assert.equal(line.source, "llm");
    assert.equal(line.proposalId, proposalId);
    assert.equal(line.text, "おはよう、今日もいい天気だね。");
    assert.ok(line.characterId, "speakerName から character が解決される");

    const taroProposalItem = adopted.proposal.items!.find((_, index) => index === taroIndex)!;
    assert.equal(taroProposalItem.itemStatus, "adopted");
    assert.equal(taroProposalItem.adoptedLineId, line.id);
    assert.equal(taroProposalItem.editedText, "おはよう、今日もいい天気だね。");
    // まだ花子の項目が proposed のままなので、proposal 全体は resolved にならない。
    assert.equal(adopted.proposal.status, "proposed");

    const persisted = getRow<{ text: string; source: string; proposal_id: string }>(
      "SELECT text, source, proposal_id FROM dialogue_lines WHERE id = ?",
      [line.id]
    );
    assert.equal(persisted!.text, "おはよう、今日もいい天気だね。");
    assert.equal(persisted!.source, "llm");
    assert.equal(persisted!.proposal_id, proposalId);
  } finally {
    server.stop(true);
  }
});

test("reject: 省略時は残り全部を却下し、proposal が resolved になる", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const script = createScript(projectId, { fountainSource: SOURCE_V1 });
  const server = startFixedMockLlm();
  try {
    configureMockLlm(server);
    const created = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
    const proposalId = created.proposal.id;
    const taroIndex = created.proposal.items!.findIndex((item) => item.speakerName === "太郎");

    adoptDialogueProposalItems(proposalId, { itemIndices: [taroIndex] });
    const rejected = rejectDialogueProposalItems(proposalId, {});
    assert.ok(rejected.proposal.items!.every((item) => item.itemStatus !== "proposed"));
    assert.equal(rejected.proposal.status, "resolved", "全項目が処理済みになったら resolved になる");
  } finally {
    server.stop(true);
  }
});

test("stale: 脚本が再取り込みされると、旧 revision に紐づく提案は isStale=true になる", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const script = createScript(projectId, { fountainSource: SOURCE_V1 });
  const server = startFixedMockLlm();
  try {
    configureMockLlm(server);
    const created = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
    assert.equal(created.proposal.isStale, false);

    addScriptRevision(script.script.id, {
      fountainSource: ["INT. 教室 - 昼", "", "@太郎", "やあ。"].join("\n")
    });

    const [refetched] = listDialogueProposals(projectId, { pageId: page.id });
    assert.equal(refetched!.id, created.proposal.id);
    assert.equal(refetched!.isStale, true);
  } finally {
    server.stop(true);
  }
});

test(
  "失敗: LLMがエラーを返し続ける場合 status='failed' + error が残り、raw_output は null",
  { timeout: 15000 },
  async () => {
    const projectId = createTestProject();
    const page = createPage(projectId);
    updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
    const script = createScript(projectId, { fountainSource: SOURCE_V1 });
    const server = startAlwaysFailingMockLlm();
    try {
      configureMockLlm(server);
      const { proposal } = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
      assert.equal(proposal.status, "failed");
      assert.ok(proposal.error);
      assert.equal(proposal.rawOutput, null);
      assert.equal(proposal.items, null);
    } finally {
      server.stop(true);
    }
  }
);

test("401はリトライせず即座に失敗する(認証エラー)", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const script = createScript(projectId, { fountainSource: SOURCE_V1 });
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      callCount += 1;
      return new Response("unauthorized", { status: 401 });
    }
  });
  try {
    configureMockLlm(server);
    const { proposal } = await createDialogueProposal(projectId, page.id, { scriptId: script.script.id });
    assert.equal(proposal.status, "failed");
    assert.equal(callCount, 1, "401 は generateStructuredJson/chatCompletion どちらの層でもリトライされない");
  } finally {
    server.stop(true);
  }
});

test("scriptId 未指定時は project 内の脚本を自動選択し、脚本が無ければ 400", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const server = startFixedMockLlm();
  try {
    configureMockLlm(server);
    await assert.rejects(createDialogueProposal(projectId, page.id, {}), HttpError);
  } finally {
    server.stop(true);
  }
});

test("LLM未設定時は 400", async () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  createScript(projectId, { fountainSource: SOURCE_V1 });
  setSetting("llm", { baseUrl: "", model: "", systemPrompt: "", temperature: 0.4 });
  await assert.rejects(createDialogueProposal(projectId, page.id, {}), HttpError);
});
