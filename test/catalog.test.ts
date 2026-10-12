import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LLM_BASE, listDroidModels, readSnapshot, toPiModels, type DroidModel } from "../src/catalog.js";

const models: DroidModel[] = [
  { id: "auto", modelProvider: "factory", kind: "router", supportedReasoningEfforts: ["none"] },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol", modelProvider: "openai", supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5-5", displayName: "Opus 5.5", modelProvider: "anthropic", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5-20251001", modelProvider: "anthropic", supportedReasoningEfforts: ["off", "low", "medium", "high"] },
  { id: "grok-4.7", modelProvider: "xai", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "kimi-k3", modelProvider: "factory", supportedReasoningEfforts: ["off", "low", "high", "max"], noImageSupport: true },
  { id: "gemini-3.5-flash", modelProvider: "google", supportedReasoningEfforts: ["low"] },
  { id: "custom:mine-0", modelProvider: "openai", isCustom: true },
  { id: "old", modelProvider: "openai", deprecated: true },
  { id: "off", modelProvider: "openai", disabled: true },
];

test("keeps only models with a verified route and maps each to its API", () => {
  const out = toPiModels(models, { models: { "kimi-k3": ["fireworks", "baseten"] } });
  const byId = Object.fromEntries(out.map((m) => [m.id, m as Record<string, unknown>]));
  assert.deepEqual(Object.keys(byId), ["gpt-6-sol", "claude-opus-5-5", "claude-haiku-4-5-20251001", "grok-4.7", "kimi-k3"]);
  assert.equal(byId["gpt-6-sol"]!.api, "openai-responses");
  assert.equal(byId["gpt-6-sol"]!.baseUrl, `${LLM_BASE}/o/v1`);
  assert.equal(byId["claude-opus-5-5"]!.api, "anthropic-messages");
  assert.equal(byId["claude-opus-5-5"]!.baseUrl, `${LLM_BASE}/a`);
  assert.deepEqual(byId["grok-4.7"]!.headers, { "x-api-provider": "xai" });
  assert.equal(byId["kimi-k3"]!.api, "openai-completions");
  assert.deepEqual(byId["kimi-k3"]!.headers, { "x-api-provider": "fireworks" });
  assert.deepEqual(byId["kimi-k3"]!.input, ["text"]);
  assert.deepEqual(byId["kimi-k3"]!.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
});

test("thinking levels follow Droid efforts", () => {
  const out = toPiModels(models);
  const byId = Object.fromEntries(out.map((m) => [m.id, m as Record<string, unknown>]));
  assert.deepEqual(byId["gpt-6-sol"]!.thinkingLevelMap, { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", off: "none" });
  // Opus 5.5 cannot disable thinking and uses adaptive effort; Haiku 4.5 uses budget thinking.
  assert.equal((byId["claude-opus-5-5"]!.thinkingLevelMap as Record<string, unknown>).off, null);
  assert.deepEqual(byId["claude-opus-5-5"]!.compat, { forceAdaptiveThinking: true });
  assert.equal(byId["claude-haiku-4-5-20251001"]!.thinkingLevelMap, undefined);
  const fable = toPiModels([{ id: "claude-fable-5", modelProvider: "anthropic", supportedReasoningEfforts: ["off", "low", "max"] }])[0] as Record<string, unknown>;
  assert.equal((fable.thinkingLevelMap as Record<string, unknown>).off, null);
  assert.deepEqual(byId["kimi-k3"]!.headers, { "x-api-provider": "baseten" });
});

test("the shipped snapshot maps to a non-empty catalog", () => {
  const out = toPiModels(readSnapshot());
  assert.ok(out.some((m) => m.id === "gpt-6-sol"));
  assert.ok(out.every((m) => !m.id.startsWith("custom:")));
});

function fakeDroid(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-catalog-"));
  const path = join(dir, "droid");
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("listDroidModels reads the droid.list_models response", async () => {
  const command = fakeDroid(`
process.stdin.once("data", (d) => {
  const req = JSON.parse(String(d));
  process.stdout.write(JSON.stringify({ type: "notification", method: "x" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "response", id: req.id, result: { models: [{ id: "gpt-6-sol", modelProvider: "openai" }] } }) + "\\n");
});
setInterval(() => {}, 1000);`);
  assert.deepEqual(await listDroidModels({ command }), [{ id: "gpt-6-sol", modelProvider: "openai" }]);
});

test("listDroidModels rejects on error response and on early exit", async () => {
  const errorCommand = fakeDroid(`
process.stdin.once("data", (d) => {
  const req = JSON.parse(String(d));
  process.stdout.write(JSON.stringify({ type: "response", id: req.id, error: { message: "nope" } }) + "\\n");
});
setInterval(() => {}, 1000);`);
  await assert.rejects(listDroidModels({ command: errorCommand }), /nope/);
  await assert.rejects(listDroidModels({ command: fakeDroid("process.exit(3)") }), /exited \(3\)/);
});
