/** Factory-aware compaction and branch summarization.
 *
 * Pi wires the `before_provider_request` hook (our Droid payload rewrite) only into the agent
 * loop; its built-in compaction and branch-summary requests are built without `onPayload`
 * (`createSummarizationOptions` in pi-coding-agent), so they reach Factory unrewritten and fail
 * with 403 content_policy_rejected. For factory models we therefore intercept `session_before_compact`
 * and `session_before_tree` and run Pi's own summarizers (`compact`, `generateBranchSummary`) with a
 * stream function that applies the same rewrite. Failures propagate: Pi reports them as extension
 * errors and, seeing no hook result, falls back to its default summarizer; non-factory models are
 * never touched.
 */
import { compact, generateBranchSummary } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./catalog.js";
import { toDroidPayload } from "./payload.js";

type ChatModel = NonNullable<ExtensionContext["model"]>;
type Registry = ExtensionContext["modelRegistry"];
/** StreamFn as accepted by `compact()` (8th positional parameter), without its optionality. */
type CompactStreamFn = NonNullable<Parameters<typeof compact>[7]>;
type BranchSummaryOptions = Parameters<typeof generateBranchSummary>[1];

/** Resolved request auth for one summarization call. */
interface RequestAuth {
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  env?: Record<string, string> | undefined;
}

/** Drops null-valued header overrides (`ProviderHeaders` allows them; request headers do not). */
function stringHeaders(headers: Record<string, string | null | undefined> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Wraps the registry so every summarization payload gets the Droid rewrite.
 *
 * Takes the registry object (not the bare method) so `this` stays bound.
 */
export function withDroidPayload(registry: Registry): CompactStreamFn {
  return (model, context, options) =>
    registry.streamSimple(model, context, {
      ...options,
      onPayload: (payload: unknown) => toDroidPayload(payload, model.api),
    });
}

/** Resolves provider auth; null when the provider has no usable credentials. */
async function resolveAuth(ctx: ExtensionContext, model: ChatModel): Promise<RequestAuth | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;
  return { apiKey: auth.apiKey, headers: stringHeaders(auth.headers), env: auth.env };
}

/** Registers the summarization hooks; every non-factory model returns `undefined` untouched. */
export function registerSummarizationHooks(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID) return undefined;
    const auth = await resolveAuth(ctx, model);
    if (!auth) return undefined;
    // Let failures propagate: Pi reports the extension error and falls back to its default
    // summarizer (pre-fix behavior) when the hook yields no result.
    const result = await compact(
      event.preparation,
      model,
      auth.apiKey,
      auth.headers,
      event.customInstructions,
      event.signal,
      ctx.thinkingLevel,
      withDroidPayload(ctx.modelRegistry),
      auth.env,
    );
    return { compaction: result };
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const model = ctx.model;
    // Pi uses an extension summary only when the user asked for one, and only summarizes non-empty
    // entry lists; skip otherwise.
    if (model?.provider !== PROVIDER_ID || !event.preparation.userWantsSummary || event.preparation.entriesToSummarize.length === 0)
      return undefined;
    const auth = await resolveAuth(ctx, model);
    if (!auth) return undefined;
    // Failures propagate to Pi's extension-error reporting; navigation then proceeds without a
    // summary, exactly as when the hook yields no result.
    const options: BranchSummaryOptions = {
      model,
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      ...(auth.env !== undefined ? { env: auth.env } : {}),
      signal: event.signal,
      ...(event.preparation.customInstructions !== undefined ? { customInstructions: event.preparation.customInstructions } : {}),
      ...(event.preparation.replaceInstructions !== undefined ? { replaceInstructions: event.preparation.replaceInstructions } : {}),
      streamFn: withDroidPayload(ctx.modelRegistry),
    };
    const result = await generateBranchSummary(event.preparation.entriesToSummarize, options);
    if (result.aborted) return { cancel: true };
    if (!result.summary) return undefined;
    return {
      summary: {
        summary: result.summary,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
      },
    };
  });
}
