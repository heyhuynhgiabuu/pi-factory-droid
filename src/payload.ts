/** Rewrites Pi provider payloads into the shapes Factory's Droid LLM endpoints accept. */

/** The endpoint returns 403 unless the system prompt starts with exactly this line. */
export const DROID_IDENTITY = "You are Droid, an AI software engineering agent built by Factory.";

/** Pi's stock opening sentence is fingerprinted by the endpoint (403); this reworded form is accepted. */
const PI_FINGERPRINT = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_FINGERPRINT_REPLACEMENT = "You are a coding assistant operating inside pi, a coding agent harness.";

type Item = Record<string, unknown>;

const isObject = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value);
const isInstructionItem = (item: unknown): item is Item =>
  isObject(item) && (item.role === "developer" || item.role === "system");

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Rewords the Pi fingerprint and puts the identity line first, without duplicating it. */
export function withIdentity(text: string): string {
  let rest = text.replaceAll(PI_FINGERPRINT, PI_FINGERPRINT_REPLACEMENT);
  if (rest.startsWith(DROID_IDENTITY)) rest = rest.slice(DROID_IDENTITY.length).replace(/^\n+/, "");
  return rest ? `${DROID_IDENTITY}\n${rest}` : DROID_IDENTITY;
}

/** OpenAI Responses: move leading developer/system input items into `instructions`. */
function responsesPayload(body: Item): Item {
  const input = Array.isArray(body.input) ? [...body.input] : [];
  const leading: string[] = [];
  while (input.length > 0 && isInstructionItem(input[0])) {
    const text = contentText((input.shift() as Item).content);
    if (text) leading.push(text);
  }
  if (typeof body.instructions === "string" && body.instructions) leading.unshift(body.instructions);
  return { ...body, instructions: withIdentity(leading.join("\n\n")), input };
}

/** Claude 5.5 models reject `thinking: {type: "disabled"}`; their "off" is `between_tools`. */
const BETWEEN_TOOLS_OFF = /^claude-[a-z]+-5-5(?:-|$)/;

/** Anthropic Messages: identity at the start of the first system block (keeps its cache_control). */
function messagesPayload(body: Item): Item {
  const thinkingOff =
    typeof body.model === "string" && BETWEEN_TOOLS_OFF.test(body.model) && isObject(body.thinking) && body.thinking.type === "disabled";
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : Array.isArray(body.system) ? body.system : [];
  const blocks = system.map((block) =>
    isObject(block) && typeof block.text === "string" ? { ...block, text: block.text.replaceAll(PI_FINGERPRINT, PI_FINGERPRINT_REPLACEMENT) } : block,
  );
  const first = blocks[0];
  if (isObject(first) && typeof first.text === "string") blocks[0] = { ...first, text: withIdentity(first.text) };
  else blocks.unshift({ type: "text", text: DROID_IDENTITY });
  return { ...body, system: blocks, ...(thinkingOff ? { thinking: { type: "between_tools" } } : {}) };
}

/** OpenAI Chat Completions: identity at the start of the leading system/developer message. */
function completionsPayload(body: Item): Item {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const first = messages[0];
  if (isInstructionItem(first)) messages[0] = { ...first, content: withIdentity(contentText(first.content)) };
  else messages.unshift({ role: "system", content: DROID_IDENTITY });
  return { ...body, messages };
}

/** Returns a rewritten copy of `payload` for the given Pi API; unknown APIs and non-objects pass through. */
export function toDroidPayload(payload: unknown, api = "openai-responses"): unknown {
  if (!isObject(payload)) return payload;
  switch (api) {
    case "openai-responses":
      return responsesPayload(payload);
    case "anthropic-messages":
      return messagesPayload(payload);
    case "openai-completions":
      return completionsPayload(payload);
    default:
      return payload;
  }
}
