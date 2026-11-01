# Workers

Five workers are registered. The honest column is the last one: what has actually been observed, not what the code is written to do.

| `provider` | Agent | Protocol | Credentials | Approval shows the human | Verified |
|---|---|---|---|---|---|
| `codex` | Codex (app-server) | JSON-RPC | Your ChatGPT sign-in | Exact command, or exact patch | **Real run, real approve and decline** (terminal) |
| `opencode` | OpenCode + Gemini | ACP | `GEMINI_API_KEY` | Exact tool input (`rawInput`) | **Real run, real approve and decline** (terminal, 2026-10-19). The stored key has since been rejected by Google (401), so re-check before relying on it. |
| `openrouter` | OpenCode + OpenRouter | ACP | `OPENROUTER_API_KEY` | Exact tool input (`rawInput`) | Simulated agent only |
| `gemini` | Gemini CLI | ACP | `GEMINI_API_KEY` | **Edits only**, with the exact diff. Shell requests are refused. | Handshake, isolated start and session creation against Gemini CLI 0.65.0. No inference, no real permission request. |
| `grok` | Grok Build | ACP | Its own login, in a hub-owned home | Exact tool input (`rawInput`) | Handshake only, and that a fresh home inherits no MCP servers. Not logged in, so nothing further. |

"Simulated agent" means the adapter is tested against `tests/fake-acp.mjs` or `tests/fake-opencode.mjs`, which copy the wire shapes observed from the real CLI. That proves the hub's logic. It does not prove the real CLI behaves as the fake does.

## Setup

Providers are chosen per task: `start_worker` takes `provider`. `scripts/start-pilot.ps1` locates the binaries and passes them to the hub; set keys in the environment that launches the hub.

| Variable | Used by | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | `opencode`, `gemini` | Gemini Developer API key |
| `OPENROUTER_API_KEY` | `openrouter` | OpenRouter key |
| `HUB_OPENCODE_MODEL` | `opencode` | `google/<model>`, default `google/gemini-3-flash-preview` |
| `HUB_OPENROUTER_MODEL` | `openrouter` | `openrouter/<vendor>/<model>`, default `openrouter/qwen/qwen3-coder` |
| `HUB_GEMINI_MODEL` | `gemini` | Plain model id, default `gemini-3-flash-preview` |
| `HUB_GROK_MODEL`, `HUB_GROK_HOME` | `grok` | Optional model; home defaults to `.local/grok-home` |
| `HUB_<NAME>_COMMAND`, `HUB_<NAME>_PREFIX_JSON` | all | Binary and leading args. Needed on Windows for npm shims, which are not launched through a shell. `start-pilot.ps1` sets these. |

## Per-worker notes

### Gemini CLI
Runs in a fresh hub-owned home with `GEMINI_CLI_HOME`, plus a system settings file that outranks user and workspace settings: approval mode `default`, YOLO and "always allow" disabled, no MCP servers, web tools excluded, telemetry off. Extensions are disabled with `--extensions none`. The hub reads back the session's mode and stops if it is not `default`.

The API key goes in the ACP `authenticate` call's `_meta['api-key']`. Passing it only through the environment produced a 401 in testing.

Shell requests are refused because Gemini's permission prompt can show a model-written description in place of the command. See the [threat model](threat-model.md#finding-acp-permission-prompts-are-not-a-uniform-trust-boundary).

### Grok
Under your real home, Grok imports far more than its own config: the Claude Code permission allow-list (232 rules on the development machine), 220 skills, hooks, plugins and memory. A worker there would not be bounded by the hub. So Grok runs in `.local/grok-home`, and you sign in once with `scripts/grok-login.ps1`. **Your real Grok token is never copied.**

The hub refuses to start Grok when the task folder contains `.grok/` or `.claude/settings*.json`, or when hooks, skills or plugins have been installed into the hub home. It starts Grok with `--no-leader`, because a shared leader process would run outside the hub's home and process tree.

### OpenRouter
The same adapter as `opencode`, with a different provider profile. One OpenRouter key reaches many hosted models. The provider is pinned: the hub refuses to start if OpenCode reports any provider other than `openrouter` as enabled. Note that OpenRouter routes your prompts and code to whichever vendor serves the model.

### Local models (Ollama): not supported, on purpose
A local model would be a good demo, but reaching a local server through OpenCode needs a custom `provider` block, and (as I understand OpenCode, not yet confirmed here) it may fetch the provider SDK at run time. The config check forbids provider overrides, since an override can redirect traffic and load code. Ollama was also not installed on the development machine. Supporting it safely needs a pinned, pre-installed SDK and a localhost-only check. That is a roadmap item, not a quiet exception.
