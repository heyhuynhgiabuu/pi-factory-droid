# pi-factory-droid

Unofficial [Pi](https://github.com/earendil-works/pi) provider for **Factory (Droid)** models. Use the
Claude, GPT, Grok and open-weight models from your Factory plan inside Pi, with **Pi** owning the agent
loop, tools, and safety hooks.

> **Unofficial, use at your own risk.** This package is not affiliated with or endorsed by Factory. It calls
> Factory's LLM endpoints the way the Droid CLI does, and rewrites requests to pass the checks those
> endpoints apply to non-Droid clients. Doing this may violate Factory's terms of service and can get your
> account restricted. Factory can change or block it at any time.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-factory-droid
```

Requirements:

- `FACTORY_API_KEY` (`fk-...`, from Factory's settings) in the environment Pi runs in.
- Optional: the [Droid CLI](https://docs.factory.ai) on `PATH`, for the live model list. Without it the
  bundled snapshot is used.

```text
/model factory/claude-opus-5-5
/model factory/gpt-6-sol
```

| Variable | Default | Purpose |
|---|---|---|
| `FACTORY_API_KEY` | (required) | Factory API key |
| `PI_FACTORY_DROID_COMMAND` | `droid` | Droid CLI used for the model list |
| `PI_FACTORY_CLIENT_VERSION` | `0.238.0` | Sent as `X-Client-Version` |

## Models

The model list comes from the Droid CLI's `droid.list_models` (stream-jsonrpc). The call creates no session
and takes about 1.5 s. Pi runs it as a background refresh. Until it finishes, and whenever the CLI is
missing or fails, the snapshot bundled with the package is used.

Only models with a verified route are listed:

| Droid `modelProvider` | Route | Pi API |
|---|---|---|
| `openai` | `/api/llm/o/v1/responses` | `openai-responses` |
| `xai` | same, plus `x-api-provider: xai` | `openai-responses` |
| `anthropic` | `/api/llm/a/v1/messages` | `anthropic-messages` |
| `factory` (open-weight) | `/api/llm/o/v1/chat/completions`, plus `x-api-provider` from Droid's routing cache (default `baseten`) | `openai-completions` |

Not listed: Gemini (Factory serves it through `/g/v1/generate`, which no Pi API speaks), the `auto`
router, `custom:` BYOK models, and disabled or deprecated entries.

Thinking levels follow each model's supported reasoning efforts, including `xhigh` and `max` where available.
Context and output limits are per-family defaults, because Droid does not publish them. Some models are not
available in every region (e.g. `minimax-m3`); the server answers 400 "Provider not available in this region".

## What the endpoints enforce

Observed in October 2026 with Droid CLI 0.238.0:

- The system prompt must start with `You are Droid, an AI software engineering agent built by Factory.`,
  or the request gets 403. The extension adds it to Responses `instructions`, to the first Anthropic `system`
  block, or to the leading chat `system` message.
- Pi's stock opening sentence (`You are an expert coding assistant operating inside pi, a coding agent harness.`)
  gets 403. The extension rewords it.
- Chat completions: the check reads only the `system` role (a `developer` message gets 403), and the upstream
  rejects `max_completion_tokens`.
- Claude thinking "off": Claude 5.5 models require `thinking: {type: "between_tools"}`. Fable does not
  support turning thinking off, so its "off" level is removed.

A 403 after a Pi or Droid update most likely means a new check. To find it, send the request body to the
endpoint in pieces and see which part fails.

## Development

```bash
npm install --ignore-scripts
npm test
npm run typecheck
pi -e ./src/index.ts   # run from source
```

To refresh `src/models.snapshot.json`, send
`{"jsonrpc":"2.0","factoryApiVersion":"1.0.0","type":"request","id":"1","method":"droid.list_models","params":{}}`
to `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`. Then save `result.models`,
leaving out entries with `isCustom: true`.

## License

MIT
