# Changelog

All notable changes to `@heyhuynhgiabuu/pi-factory-droid` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- `factory` provider for Pi that calls Factory's Droid LLM endpoints directly with `FACTORY_API_KEY`, so Pi
  owns the agent loop, tools, and safety hooks.
- Model catalog from the Droid CLI (`droid.list_models`, no session created), refreshed in the background,
  with a bundled snapshot as fallback. 49 models across four routes: OpenAI and xAI (Responses), Anthropic
  (Messages), and Factory-hosted open-weight models (Chat Completions with `x-api-provider` routing).
- Thinking levels per model from Droid's supported reasoning efforts, including `xhigh` and `max`.
- Request rewriting for the endpoint's requirements: the Droid identity line, a reworded Pi opening
  sentence, a `system` role for chat models, `max_tokens`, and Claude 5.5's `between_tools` thinking-off mode.
