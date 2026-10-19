# Installed compatibility record

Observed on the user's Windows host during this build. No credential files were read by our application and no tokens were copied.

| Component | Observed version/access | Verification |
|---|---|---|
| Node | v22.17.0 | Native node --version |
| npm | 10.9.2 | Native npm --version |
| Claude Code | 2.1.302 | Native version; auth status: logged in, claude.ai, firstParty, Pro |
| Codex | 0.162.0-alpha.17.2 | Native version; login status: ChatGPT |
| MCP SDK | 1.32.1 | Local pinned dependency |
| Zod | 4.6.7 | Local pinned dependency |
| TypeScript | 7.0.2 | Build compiler |
| @types/node | 22.20.5 | Local Node22 types |
| Installed app-server protocol | Generated using codex app-server generate-ts --out protocol --experimental | Local ignored schema inputs; inspect again after CLI upgrade |
| Native Claude Remote Control flags | --strict-mcp-config, --mcp-config, --setting-sources project,local, --permission-mode manual, --no-chrome, --remote-control [name] | Installed CLI help; launch script parsed, interactive startup not yet proven here |

The application checks actual native Codex account type, forced ChatGPT/OpenAI provider, disabled integration flags, notification hooks, returned fixture/sandbox/user-review settings and empty thread MCP inventory before starting inference. Failed checks stop the task. The native smoke is a separate bounded inference command; its result must be recorded after actually running it.

### Native Codex smoke — 2026-10-19

Codex version: `codex-cli 0.163.0-alpha.10.2` (bundled with the Codex app; not on PATH by default, so the smoke was run with its folder prepended to PATH). Result: **stopped before inference, by design.** Output: `"state": "failed", "error": "Worker inherited MCP integrations; pilot stopped before inference"`. The user's Codex setup enables MCP servers (`claude-mem`, `mcp-search`, `cua_repl`, `node_repl`) that come from plugins and the Codex app rather than `mcp_servers` in config.toml, so the hub's `mcp_servers={}` override does not remove them and its thread-inventory check refuses to continue. This shows the fail-closed check working against a real Codex. A passing smoke needs either those servers disabled for the hub's worker or an adapter change in src/worker.ts (off-limits; human decision).

### Native OpenCode run — 2026-10-19

OpenCode 1.19.1 (WinGet `SST.opencode`, real `opencode.exe`), driven through the hub's MCP tools with every approval auto-declined. All pre-inference checks passed and the ACP session started. `google/gemini-2.5-pro` was refused by Gemini ("no longer available to new users"); `google/gemini-3.1-pro-preview` failed on free-tier quota (limit 0). `google/gemini-3-flash-preview` **completed** a read-only summary of the fixture README with zero approval requests. This verifies real inference and result delivery, not human approval: a real `session/request_permission` has still not been observed or answered.

Follow-up (same day): real Codex lists hub-disabled servers with `runtimeStatus: "disabled"` (never started, no tools); the check now accepts only those (commit abff3a2). The worker also had no shell or file tools because `environments: []` disables environment access; it now gets one `local` environment rooted in the task folder. `scripts/smoke.mjs` then **completed** on real Codex and summarized the fixture README correctly.

### Real OpenCode approval — 2026-10-19

Run through `scripts/start-pilot.ps1 -NoRemote` (terminal, not phone). Prompt: run `node --version`. The hub presented exactly one `session/request_permission` with `rawInput: {"command":"node --version"}`; the human chose allow once; the worker returned `v22.17.0`, matching a manual run. The task then reported `Process tree cleanup unconfirmed; workspace stays locked` although no OpenCode process remained. The same approved run outside Claude Code (immediate and 90 s delayed approval) stopped cleanly with taskkill exit 0, so the cause is not yet known; the error now includes taskkill's output (commit 2792b51). A real decline has not been run yet.

Adapter verification passed locally: TypeScript build and 50 automated tests, including MCP integration tests using fake provider processes and focused safety, repository and store regressions. These tests do not establish native provider inference or phone approval success.

Remaining Phase0/1 evidence: a real Codex approval answered by the human, a real OpenCode decline and the cause of the pilot-only cleanup error, native Claude lead inference/delegation, real user approval and questions in the iPhone interface, cellular reconnect and completion notification. See phone-results.md; all phone rows remain unverified until a human observes them.

Sources used for installed interface mapping:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/remote-control

Generated schemas and CLI help are authoritative for this installed alpha build. The prototype does not assume arbitrary future Codex versions remain compatible.
