import assert from "node:assert/strict";
import { test } from "node:test";
import { DROID_IDENTITY, toDroidPayload } from "../src/payload.js";

const PI_LINE = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const REWORDED = "You are a coding assistant operating inside pi, a coding agent harness.";

test("responses: leading developer message becomes identity-prefixed instructions", () => {
  const out = toDroidPayload({
    input: [
      { role: "developer", content: "Pi system prompt" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  }) as { instructions: string; input: unknown[] };
  assert.equal(out.instructions, `${DROID_IDENTITY}\nPi system prompt`);
  assert.deepEqual(out.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
});

test("responses: identity is always present and never duplicated; later system items stay", () => {
  assert.equal((toDroidPayload({ input: [] }) as { instructions: string }).instructions, DROID_IDENTITY);
  const out = toDroidPayload({ instructions: `${DROID_IDENTITY}\nx`, input: [] }) as { instructions: string };
  assert.equal(out.instructions, `${DROID_IDENTITY}\nx`);
  const later = { role: "system", content: "mid" };
  const kept = toDroidPayload({ input: [{ role: "user", content: "a" }, later] }) as { input: unknown[] };
  assert.deepEqual(kept.input, [{ role: "user", content: "a" }, later]);
});

test("Pi's fingerprinted opening sentence is reworded", () => {
  const out = toDroidPayload({ input: [{ role: "developer", content: `${PI_LINE} Rest.` }] }) as { instructions: string };
  assert.equal(out.instructions, `${DROID_IDENTITY}\n${REWORDED} Rest.`);
});

test("anthropic: identity prefixes the first system block and keeps cache_control", () => {
  const cache = { type: "ephemeral" };
  const out = toDroidPayload({ system: [{ type: "text", text: PI_LINE, cache_control: cache }], messages: [] }, "anthropic-messages") as {
    system: { text: string; cache_control?: unknown }[];
  };
  assert.deepEqual(out.system, [{ type: "text", text: `${DROID_IDENTITY}\n${REWORDED}`, cache_control: cache }]);
  const bare = toDroidPayload({ messages: [] }, "anthropic-messages") as { system: unknown[] };
  assert.deepEqual(bare.system, [{ type: "text", text: DROID_IDENTITY }]);
});

test("anthropic: Claude 5.5 thinking off becomes between_tools; other models keep disabled", () => {
  const off = (model: string) =>
    (toDroidPayload({ model, thinking: { type: "disabled" }, messages: [] }, "anthropic-messages") as { thinking: unknown }).thinking;
  assert.deepEqual(off("claude-sonnet-5-5"), { type: "between_tools" });
  assert.deepEqual(off("claude-opus-5-5-fast"), { type: "between_tools" });
  assert.deepEqual(off("claude-sonnet-5"), { type: "disabled" });
  const adaptive = toDroidPayload({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" }, messages: [] }, "anthropic-messages") as { thinking: unknown };
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
});

test("completions: identity prefixes the leading system message, or is inserted", () => {
  const out = toDroidPayload({ messages: [{ role: "system", content: PI_LINE }, { role: "user", content: "hi" }] }, "openai-completions") as {
    messages: { role: string; content: string }[];
  };
  assert.deepEqual(out.messages[0], { role: "system", content: `${DROID_IDENTITY}\n${REWORDED}` });
  const bare = toDroidPayload({ messages: [{ role: "user", content: "hi" }] }, "openai-completions") as { messages: unknown[] };
  assert.deepEqual(bare.messages[0], { role: "system", content: DROID_IDENTITY });
});

test("unknown APIs pass through untouched", () => {
  const payload = { contents: [] };
  assert.equal(toDroidPayload(payload, "google-generative-ai"), payload);
});
