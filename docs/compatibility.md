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

Adapter verification passed locally: TypeScript build; seven integration tests using real MCP stdio plus a fake Codex protocol process; ten focused safety regressions. These are simulated provider tests, not a native phone success claim.

Remaining Phase0/1 evidence: native Codex inference (independent verifier), native Claude lead inference/delegation, real user approval and questions in the iPhone interface, cellular reconnect and completion notification. See phone-results.md; all phone rows remain unverified until a human observes them.

Sources used for installed interface mapping:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/remote-control

Generated schemas and CLI help are authoritative for this installed alpha build. The prototype does not assume arbitrary future Codex versions remain compatible.
