import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DROID_IDENTITY, toDroidPayload } from "../src/payload.js";
import { registerSummarizationHooks, withDroidPayload } from "../src/summarize.js";

const PI_LINE = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const REWORDED = "You are a coding assistant operating inside pi, a coding agent harness.";

const assistantMsg = {
  role: "assistant",
  api: "openai-responses",
  provider: "factory",
  model: "m1",
  content: [{ type: "text", text: "SUM" }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
};

const model = {
  provider: "factory",
  id: "m1",
  api: "openai-responses",
  name: "m1",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

/** Fake ModelRuntime: records streamSimple options, resolves a fake API key, replays `assistantMsg`. */
function fakeRuntime() {
  const calls = [];
  return {
    calls,
    async getAuth() {
      return { auth: { apiKey: "test-key", headers: {} }, env: undefined, source: "test" };
    },
    streamSimple(streamModel, context, options) {
      calls.push({ model: streamModel, options });
      return { result: async () => structuredClone(assistantMsg) };
    },
  };
}

/** Captures hook handlers through a minimal fake ExtensionAPI. */
function captureHandlers() {
  const handlers = new Map();
  registerSummarizationHooks({ on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

function makeCtx(runtime) {
  return { model, modelRegistry: new ModelRegistry(runtime), thinkingLevel: "off" };
}

test("withDroidPayload forwards options and applies the Droid rewrite via onPayload", async () => {
  let captured;
  const registry = {
    streamSimple: (m, c, options) => {
      captured = options;
      return "stream";
    },
  };
  const out = withDroidPayload(registry)(model, { messages: [] }, { maxTokens: 1024 });
  assert.equal(out, "stream");
  assert.equal(captured.maxTokens, 1024);
  assert.equal(typeof captured.onPayload, "function");
  const rewritten = await captured.onPayload({ instructions: PI_LINE, input: [{ role: "user", content: "hi" }] });
  assert.deepEqual(rewritten, {
    instructions: `${DROID_IDENTITY}\n${REWORDED}`,
    input: [{ role: "user", content: "hi" }],
  });
});

test("compact hook runs Pi's compact through a real ModelRegistry with the rewrite applied", async () => {
  const runtime = fakeRuntime();
  const onCompact = captureHandlers().get("session_before_compact");
  const event = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 10,
      previousSummary: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 200 },
    },
    branchEntries: [],
    customInstructions: "focus",
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const result = await onCompact(event, makeCtx(runtime));
  assert.equal(runtime.calls.length, 1);
  assert.equal(typeof runtime.calls[0].options.onPayload, "function");
  assert.equal(runtime.calls[0].options.apiKey, "test-key");
  const rewritten = await runtime.calls[0].options.onPayload({ instructions: PI_LINE, input: [] });
  assert.equal(rewritten.instructions, `${DROID_IDENTITY}\n${REWORDED}`);
  assert.ok(result.compaction.summary.includes("SUM"));
  assert.equal(result.compaction.firstKeptEntryId, "keep-1");
  assert.equal(result.compaction.tokensBefore, 10);
  assert.deepEqual(result.compaction.details, { readFiles: [], modifiedFiles: [] });
});

test("tree hook summarizes through the same path, gated on userWantsSummary and non-empty entries", async () => {
  const runtime = fakeRuntime();
  const onTree = captureHandlers().get("session_before_tree");
  const entries = [
    { type: "message", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hello", timestamp: 1 } },
  ];
  const makeEvent = (userWantsSummary, entriesToSummarize) => ({
    type: "session_before_tree",
    preparation: { targetId: "e1", oldLeafId: null, commonAncestorId: null, entriesToSummarize, userWantsSummary },
    signal: new AbortController().signal,
  });

  const result = await onTree(makeEvent(true, entries), makeCtx(runtime));
  assert.equal(runtime.calls.length, 1);
  assert.equal(typeof runtime.calls[0].options.onPayload, "function");
  assert.ok(result.summary.summary.includes("SUM"));
  assert.deepEqual(result.summary.details, { readFiles: [], modifiedFiles: [] });

  assert.equal(await onTree(makeEvent(false, entries), makeCtx(runtime)), undefined);
  assert.equal(await onTree(makeEvent(true, []), makeCtx(runtime)), undefined);
  assert.equal(runtime.calls.length, 1, "gated paths must not stream");
});

test("non-factory models return undefined without touching the registry", async () => {
  const runtime = fakeRuntime();
  const ctx = makeCtx(runtime);
  const otherModel = { ...model, provider: "anthropic", api: "anthropic-messages" };
  const ctxOther = { ...ctx, model: otherModel };
  const onCompact = captureHandlers().get("session_before_compact");
  const onTree = captureHandlers().get("session_before_tree");
  const compactEvent = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "keep-1",
      messagesToSummarize: [{ role: "user", content: "hi", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 200 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
  assert.equal(await onCompact(compactEvent, ctxOther), undefined);
  const treeEvent = {
    type: "session_before_tree",
    preparation: {
      targetId: "e1",
      oldLeafId: null,
      commonAncestorId: null,
      entriesToSummarize: [{ type: "message", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hi", timestamp: 1 } }],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
  assert.equal(await onTree(treeEvent, ctxOther), undefined);
  assert.equal(runtime.calls.length, 0);
});

test("toDroidPayload stays the single rewrite entry point (sanity)", () => {
  assert.equal(toDroidPayload({ instructions: PI_LINE, input: [] }, "openai-responses").instructions, `${DROID_IDENTITY}\n${REWORDED}`);
});
