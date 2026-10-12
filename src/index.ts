/**
 * Pi provider `factory`: calls Factory's Droid LLM endpoints directly, so Pi owns the agent loop and tools.
 * Unofficial: mimics the Droid CLI; may break or violate Factory ToS. Requires FACTORY_API_KEY (fk-...).
 * Models come from the Droid CLI (`droid.list_models`), with a shipped snapshot until the first refresh.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LLM_BASE, listDroidModels, readProviderRouting, readSnapshot, toPiModels } from "./catalog.js";
import { toDroidPayload } from "./payload.js";

const PROVIDER_ID = "factory";
const CLIENT_VERSION = process.env.PI_FACTORY_CLIENT_VERSION ?? "0.238.0";
const DROID_COMMAND = process.env.PI_FACTORY_DROID_COMMAND ?? "droid";

export default function factoryExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Factory",
    baseUrl: `${LLM_BASE}/o/v1`,
    apiKey: "$FACTORY_API_KEY",
    authHeader: true,
    api: "openai-responses",
    headers: { "X-Client-Version": CLIENT_VERSION },
    models: toPiModels(readSnapshot(), readProviderRouting()),
    async refreshModels(context) {
      if (!context.allowNetwork) return toPiModels(readSnapshot(), readProviderRouting());
      try {
        return toPiModels(await listDroidModels({ command: DROID_COMMAND, signal: context.signal }), readProviderRouting());
      } catch {
        // Droid CLI missing or failing: keep serving the shipped snapshot.
        return toPiModels(readSnapshot(), readProviderRouting());
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return undefined;
    return toDroidPayload(event.payload, ctx.model.api);
  });
}
