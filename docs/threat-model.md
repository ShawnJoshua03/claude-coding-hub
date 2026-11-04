# Threat model

A coding agent that can run commands and write files is a program you did not write, steered by text you did not review. This hub lets one agent (the lead) hand work to other agents (workers). The question this document answers is: **what can a misbehaving or manipulated worker do, and what stops it?**

## What is trusted

| Party | Trust | Why |
|---|---|---|
| The human | Fully | Only they can approve an action. |
| The native MCP client (Claude Code) | To show forms honestly | It renders the approval form and returns the human's click. The hub cannot prove a response came from a person (see "Residual risk"). |
| The hub (`src/`) | To enforce the rules below | Under 1,000 lines of TypeScript, deliberately small so it can be read. |
| The lead model (Claude) | **Not trusted with approvals** | It can start, wait for and cancel workers. No tool accepts an approval from it. |
| Worker agents (Codex, Gemini, Grok, OpenCode models) | **Untrusted** | They read project files and web content, so they can be prompt-injected. Their output is data. |
| Everything inside a worker's folder | **Untrusted** | The worker can write any of it, including `.git`, hooks, and tool config files. |

## Attacks and what stops them

Each row names the test that fails if the defence is removed. Rows marked *mutation-checked* were verified by deliberately breaking the defence and confirming a test went red.

| # | Attack | Defence | Test |
|---|---|---|---|
| 1 | Worker approves its own action, or the lead model approves for the human | No tool accepts a decision. Approvals exist only as MCP **form elicitation** answered by the client. | `unsupported client cannot silently grant worker approval`; `one-shot human form maps to provider accept` |
| 2 | Worker retries a refused action in new words | A decline stops the whole task and invalidates every pending request. | `decline stops task and no rephrased retry follows` |
| 3 | Late or duplicate answer revives a cancelled task | A decision is answered at most once and never after a terminal state. | `concurrent waits elicit once; cancellation invalidates late response` |
| 4 | Stale or cross-task approval is applied to the wrong turn | Every request is matched to thread, turn and session ids. | `stale or cross-task approvals/completions cannot alter live task` |
| 5 | Approval grants more than the human saw ("always allow", persistent root grants) | Only the provider's `allow_once` option is ever selected. Persistent grants are refused. | `file approval requires matching exact diff and refuses persistent root grant`; `gemini: ... allow-once selects only proceed_once` |
| 6 | **The permission prompt hides the real action** | A request is forwarded only if it carries an exact, verifiable view: the command (`rawInput`) or the diff. Otherwise it is refused and the human is never asked. See "Finding" below. | `gemini: a shell request showing only a title is refused...` *(mutation-checked)* |
| 7 | Worker rewrites `.git/hooks` or `core.hooksPath`, so the hub's own git call runs attacker code | The hub runs git outside the sandbox with hooks, fsmonitor and diff drivers disabled. Plain git is exploited by the same attack. | `host git never runs a hook the worker rewrote` |
| 8 | Worker replaces its `.git` pointer file with a path to a repo it planted | Host git uses the gitdir recorded **before** the worker started, never discovery. | `worker redirecting its .git pointer cannot steer host git` |
| 9 | Worker plants project config that grants itself permissions or loads code (`opencode.json`, `.opencode/`, `.gemini/`, `.claude/settings.json`, `.grok/`) | Startup is refused if any exist between the task folder and its git root. | `opencode: project config ... refused`; `gemini: a .gemini folder ... refused`; `grok: project permission rules, hooks and installed plugins are refused` |
| 10 | Worker inherits your credentials, global MCP servers, plugins or skills | Environment is an allowlist. Each worker gets a hub-owned home. Codex's MCP inventory must be empty or inert. | `opencode: worker env carries only the allowlist...`; `gemini: environment is isolated...`; `mcp: a server the hub never saw in config ... stops the task` |
| 11 | Provider silently runs in a looser mode (YOLO, "allow all") | The hub reads back the effective mode and refuses to start if it differs from what it asked for. | `gemini: ... a yolo session ... stop the task`; `opencode: loosened permissions or plugins stop the task before inference` |
| 12 | Giant patch or request floods the approval form so the dangerous part scrolls away | Requests over 20,000 characters are refused. | `oversized captured patch cannot flood human approval form` |
| 13 | Worker asks the client for file or terminal access | The client advertises neither capability and refuses `fs/*` and `terminal/*`. | `gemini: other refusals (... fs request)` |
| 14 | Orphaned worker keeps running after cancel | The workspace stays locked until the whole process tree is confirmed dead. | `unexpected exited parent keeps fixture locked until external cleanup` |
| 15 | Hostile repo: symlinks that escape the workspace | Links and junctions inside a workspace are refused (`scanLinks`). | No dedicated test yet; listed under gaps in the README. |

## Finding: ACP permission prompts are not a uniform trust boundary

The Agent Client Protocol lets an agent ask the client for permission, and several agents speak it (Gemini CLI, Grok, OpenCode). It is tempting to treat "the agent asked, the human said yes" as the same guarantee everywhere. **It is not.**

- **OpenCode** includes `rawInput`, the exact tool arguments. The hub shows them verbatim.
- **Gemini CLI 0.65.0** sends no `rawInput`. For a shell request it sends a `title`. Reading its source (`ShellToolInvocation.getDescription`), the title is the command **only when the command is short**; for a longer command Gemini substitutes the model-written `description`. A manipulated model can therefore make a long destructive command appear as "Tidy up temporary files". For edits, `content` does carry the exact diff.

So the Gemini adapter forwards edits, which are verifiable, and **refuses every shell request**, because the hub cannot tell whether the title it received is the command or the model's gloss. The same hook (`unreviewable()` in `src/acp.ts`) lets each future adapter state what it can prove.

The cost is that a Gemini worker cannot run commands. That is the right default: an approval form that can be made to lie is worse than no form.

## Residual risk (honest list)

- **No OS sandbox for OpenCode, Gemini or Grok.** Once you approve an action it runs as you, unsandboxed. Codex has a workspace-write sandbox with no network; the others rely on approval alone.
- **A compromised client can auto-answer.** The hub cannot cryptographically prove a form response came from a human. Do not install auto-answer hooks for this pilot.
- **Clean/smudge filters you configured yourself** (for example Git LFS) still run on worker-written files that select them.
- **Approved commands see their environment.** An approved OpenCode or Gemini command runs with that worker's API key in its environment.
- **Phone approval does not work.** Claude Remote Control did not render MCP forms on an iPhone (see [phone-results.md](phone-results.md)). Approvals happen in the desktop or terminal client.
- **Provider internals drift.** Checks are written against Codex 0.163 alpha, OpenCode 1.19, Gemini CLI 0.65 and Grok 1.0.70. A new version can change a wire shape; the checks fail closed, but expect to re-verify after upgrades.
- **Unverified adapters.** Gemini CLI, Grok and OpenRouter have not completed a real permission request. Their tests use simulated agents.
