import { createId } from "../db";
import type { GenerationIntent } from "../../shared/generationIntent";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderCollectContext,
  ProviderCollectedImage,
  ProviderInterruptResult,
  ProviderJobEventStatus,
  ProviderJobStatus,
  ProviderSubmitContext,
  ProviderSubmittedJob,
  ProviderValidation,
  ProviderWatchContext
} from "./types";

/**
 * テスト専用の GenerationProvider(Docs/Feature-ScriptToManga.md S1 契約テスト)。インメモリの
 * ジョブストアを持ち、submit/collectImages/interrupt と部分失敗(N 番目のジョブだけ fail 等)を
 * プログラム可能にする。`watchProgress` は ctx を保持するだけで自発的には何も push しない
 * (rounds.ts の `ensureRoundMonitor` は無害に呼べる)。テストが明示的に `emitFakeJobEvent` を
 * 呼ばない限り、collect は常に「watch が張れない/使わない場合の collectImages(+getStatus)による
 * ポーリングだけで完走する」経路を通る(GenerationProvider IF の watch はあくまで最適化、という
 * ドキュメントの前提を裏付ける契約テスト4 が使う)。
 *
 * jobs マップは Comfy でいう「ComfyUI サーバ側の history」に相当する外部ストアのつもりで、
 * このモジュールの再読み込みや guruguru プロセスの再起動をまたいでも失われない体で使う
 * (= rounds.ts 側のプロセス内状態(roundProgress 等)に依存せず、DB の generation_jobs 行 +
 * この「外部ストア」だけで collect が完走できることを契約テスト4で検証する)。
 */

export type FakeJobOutcome =
  | { status: "completed"; images?: ProviderCollectedImage[] }
  | { status: "failed" };

interface FakeJobState {
  outcome: FakeJobOutcome;
  collected: boolean;
}

const jobs = new Map<string, FakeJobState>();
const runningRefs = new Set<string>();
const watchers = new Map<string, ProviderWatchContext>();
let nextOutcomes: FakeJobOutcome[] | null = null;

function defaultOutcome(jobRef: string): Extract<FakeJobOutcome, { status: "completed" }> {
  return {
    status: "completed",
    images: [
      {
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        filename: `${jobRef}.png`,
        outputNodeId: "fake-node"
      }
    ]
  };
}

/**
 * 次の submit() で作られるジョブの結果を、batchIndex 順に programam する。配列が短ければ残りは
 * デフォルト(成功)になる。プログラムした配列は一度使われると(submit 呼び出しごとに)消費されない
 * ため、複数ラウンドをまたいで使い回さないよう各テストで `resetFakeProvider()` を呼ぶこと。
 */
export function programFakeOutcomes(outcomes: FakeJobOutcome[]) {
  nextOutcomes = outcomes;
}

/** jobRef を interrupt() の queue 照合で「実行中」として返すようにプログラムする(契約テスト3)。 */
export function markFakeJobRunning(jobRef: string) {
  runningRefs.add(jobRef);
}

export function resetFakeProvider() {
  jobs.clear();
  runningRefs.clear();
  watchers.clear();
  nextOutcomes = null;
}

function watchProgress(ctx: ProviderWatchContext): void {
  watchers.set(ctx.roundId, ctx);
}

function stopWatch(roundId: string): void {
  watchers.delete(roundId);
}

/**
 * テストが明示的に「Provider からの状態変化通知」(Comfy の WebSocket イベント相当)を模擬するための
 * フック。`createGenerationRound` が内部で `ensureRoundMonitor` → `watchProgress` を呼んだ後でないと
 * 対応する watcher が無いため、契約テスト2(部分失敗)はラウンド作成後にこれを呼ぶ。
 */
export function emitFakeJobEvent(roundId: string, jobRef: string, status: ProviderJobEventStatus, error?: unknown) {
  const ctx = watchers.get(roundId);
  if (!ctx) {
    throw new Error(`emitFakeJobEvent: no watcher registered for round ${roundId}. Was ensureRoundMonitor called?`);
  }
  ctx.onJobUpdate(jobRef, status, error);
}

// `recipe` is accepted for interface compatibility; the fake provider has a single fixed profile.
async function resolveCapabilities(_recipe: { recipeId: string; revision?: string }): Promise<ProviderCapabilities> {
  return {
    providerId: "fake",
    displayName: "Fake Provider (tests only)",
    modelFamily: "fake",
    features: {
      transform: true,
      inpaint: true,
      controlPose: true,
      controlEdge: true,
      identityReference: true,
      styles: true,
      pageGeneration: false
    },
    alpha: "native",
    seed: "reproducible",
    checkedAt: new Date().toISOString()
  };
}

async function validateIntent(intent: GenerationIntent): Promise<ProviderValidation> {
  const issues: string[] = [];
  if (intent.batchCount < 1 || intent.batchCount > 32) {
    issues.push("batchCount must be between 1 and 32");
  }
  return { ok: issues.length === 0, issues };
}

async function submit(ctx: ProviderSubmitContext): Promise<ProviderSubmittedJob[]> {
  const submitted: ProviderSubmittedJob[] = [];
  ctx.jobs.forEach((job, index) => {
    const jobRef = createId("fake_job");
    const programmed = nextOutcomes?.[index];
    // A programmed "completed" outcome without explicit `images` still gets a real (default) image
    // — otherwise collectImages would silently return [] forever and the job would never complete.
    const outcome: FakeJobOutcome =
      !programmed
        ? defaultOutcome(jobRef)
        : programmed.status === "completed"
          ? { status: "completed", images: programmed.images ?? defaultOutcome(jobRef).images }
          : programmed;
    jobs.set(jobRef, { outcome, collected: false });
    submitted.push({ jobRef, nativeSubmission: { fake: true, batchIndex: job.batchIndex }, seed: job.seed, watchRef: jobRef });
  });
  return submitted;
}

async function getStatus(jobRef: string): Promise<ProviderJobStatus> {
  const job = jobs.get(jobRef);
  if (!job) {
    return "unknown";
  }
  return job.outcome.status === "failed" ? "failed" : "completed";
}

async function collectImages(jobRef: string, ctx: ProviderCollectContext): Promise<ProviderCollectedImage[]> {
  void ctx;
  const job = jobs.get(jobRef);
  if (!job || job.outcome.status !== "completed" || job.collected) {
    return [];
  }
  job.collected = true;
  return job.outcome.images ?? [];
}

async function interrupt(jobRefs: string[], hasLocallyRunningJob: boolean): Promise<ProviderInterruptResult> {
  const runningJobRefs = jobRefs.filter((ref) => runningRefs.has(ref));
  const interruptedRunning = runningJobRefs.length > 0 || hasLocallyRunningJob;
  return { interruptedRunning, runningJobRefs, queueError: null, deleteError: null, interruptError: null };
}

export const fakeProvider: GenerationProvider = {
  id: "fake",
  resolveCapabilities,
  validateIntent,
  submit,
  getStatus,
  collectImages,
  interrupt,
  watchProgress,
  stopWatch
};
