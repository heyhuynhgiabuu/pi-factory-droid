/** Factory model catalog: Droid CLI `droid.list_models` entries mapped to Pi chat models on Factory's LLM routes. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const LLM_BASE = "https://prem.factory.ai/api/llm";
/** Provider id under which the Droid models are registered with Pi. */
export const PROVIDER_ID = "factory";

/** Fields of a `droid.list_models` entry this catalog relies on. */
export interface DroidModel {
  id: string;
  displayName?: string;
  modelProvider?: string;
  kind?: string;
  supportedReasoningEfforts?: string[];
  noImageSupport?: boolean;
  deprecated?: boolean;
  disabled?: boolean;
  isCustom?: boolean;
}

/** `provider_routing` from Droid's feature-flag cache: which upstream serves each open-weight model. */
export interface ProviderRouting {
  defaults?: Record<string, string[]>;
  models?: Record<string, string[]>;
}

type PiLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const PI_LEVELS: PiLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Map Droid efforts onto Pi levels; unsupported levels are null so Pi clamps to a neighbour. */
function thinkingMap(efforts: string[], offValue: string | undefined): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const level of PI_LEVELS) map[level] = efforts.includes(level) ? level : null;
  const canDisable = efforts.includes("off") || efforts.includes("none");
  if (!canDisable) map.off = null;
  else if (offValue !== undefined) map.off = offValue;
  return map;
}

function upstreamFor(id: string, routing: ProviderRouting | undefined): string {
  return routing?.models?.[id]?.[0] ?? routing?.defaults?.factory?.[0] ?? "baseten";
}

/**
 * Converts Droid models to Pi models, keeping only those with a verified Factory route:
 * openai/xai → Responses, anthropic → Messages, factory (open-weight) → Chat Completions.
 * Google (`/g/v1/generate`) has no matching Pi API and is skipped, as are routers, custom (BYOK),
 * disabled and deprecated entries.
 */
export function toPiModels(models: readonly DroidModel[], routing?: ProviderRouting): ProviderModelConfig[] {
  const out: ProviderModelConfig[] = [];
  for (const m of models) {
    if (!m.id || m.isCustom || m.disabled || m.deprecated || m.kind === "router") continue;
    const efforts = m.supportedReasoningEfforts ?? [];
    const reasoning = efforts.some((e) => e !== "off" && e !== "none");
    const base = {
      id: m.id,
      name: `${m.displayName ?? m.id} (Factory)`,
      reasoning,
      input: (m.noImageSupport ? ["text"] : ["text", "image"]) as ("text" | "image")[],
      cost: ZERO_COST,
    };
    switch (m.modelProvider) {
      case "openai":
      case "xai":
        out.push({
          ...base,
          api: "openai-responses",
          baseUrl: `${LLM_BASE}/o/v1`,
          contextWindow: m.modelProvider === "xai" ? 256_000 : 272_000,
          maxTokens: m.modelProvider === "xai" ? 64_000 : 128_000,
          ...(reasoning ? { thinkingLevelMap: thinkingMap(efforts, "none") } : {}),
          ...(m.modelProvider === "xai" ? { headers: { "x-api-provider": "xai" } } : {}),
        });
        break;
      case "anthropic": {
        // Claude models offering xhigh/max use adaptive (effort-based) thinking; older ones use budgets.
        // Fable rejects `thinking: disabled` although Droid lists "off"; drop it so Pi clamps to a real effort.
        const anthropicEfforts = m.id.startsWith("claude-fable-") ? efforts.filter((e) => e !== "off") : efforts;
        const adaptive = efforts.includes("xhigh") || efforts.includes("max");
        out.push({
          ...base,
          api: "anthropic-messages",
          baseUrl: `${LLM_BASE}/a`,
          contextWindow: 200_000,
          maxTokens: 64_000,
          ...(adaptive ? { thinkingLevelMap: thinkingMap(anthropicEfforts, undefined), compat: { forceAdaptiveThinking: true } } : {}),
        });
        break;
      }
      case "factory":
        out.push({
          ...base,
          api: "openai-completions",
          baseUrl: `${LLM_BASE}/o/v1`,
          contextWindow: 128_000,
          maxTokens: 32_000,
          headers: { "x-api-provider": upstreamFor(m.id, routing) },
          // The identity guard only reads a `system` message (developer → 403); upstreams reject max_completion_tokens.
          compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
          ...(reasoning ? { thinkingLevelMap: thinkingMap(efforts, undefined) } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Reads `provider_routing` from Droid's feature-flag cache; undefined when absent or unreadable. */
export function readProviderRouting(path = join(homedir(), ".factory", "cache", "feature-flags.json")): ProviderRouting | undefined {
  try {
    const flags = JSON.parse(readFileSync(path, "utf8")) as { flags?: Record<string, unknown> };
    const routing = flags.flags?.provider_routing;
    return routing && typeof routing === "object" ? (routing as ProviderRouting) : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot of `droid.list_models` shipped with the extension, used until a live refresh succeeds. */
export function readSnapshot(): DroidModel[] {
  return JSON.parse(readFileSync(new URL("./models.snapshot.json", import.meta.url), "utf8")) as DroidModel[];
}

/**
 * Asks the Droid CLI for its model list over stream-jsonrpc (`droid.list_models`). No session is created.
 * Rejects on timeout, abort, spawn failure, or an error response.
 */
export function listDroidModels(options: { command?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DroidModel[]> {
  const command = options.command ?? "droid";
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, models?: DroidModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const onAbort = () => finish(new Error("droid.list_models aborted"));
    const timer = setTimeout(() => finish(new Error("droid.list_models timed out")), options.timeoutMs ?? 20_000);
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`droid exited (${code}) before answering droid.list_models`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: { models?: unknown }; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== "list-models") continue;
        if (message.error) return finish(new Error(`droid.list_models failed: ${message.error.message ?? "unknown error"}`));
        const models = message.result?.models;
        return Array.isArray(models) ? finish(undefined, models as DroidModel[]) : finish(new Error("droid.list_models returned no models"));
      }
    });
    // Keep stdin open until the answer arrives; the child is killed in finish().
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", factoryApiVersion: "1.0.0", type: "request", id: "list-models", method: "droid.list_models", params: {} })}\n`,
    );
  });
}
