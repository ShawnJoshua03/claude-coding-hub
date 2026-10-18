# Claude coding hub pilot

This is the first feasibility build: native Claude Code is the lead, and one Codex worker runs through a local MCP connection. The iPhone conversation and its permission forms still require an actual phone test. There is no public server, custom phone interface, paid API setup or global agent-settings change.

## Run locally

Prerequisites already detected on this host: Node 22.17.0, npm 10.9.2, Claude Code 2.1.302 (native Claude Pro sign-in), Codex 0.162.0-alpha.17.2 (ChatGPT sign-in). Installed project dependencies are locked in package-lock.json. Generated installed Codex types are in protocol/.

```powershell
cd C:\Users\shawn\projects\claude-coding-hub
npm.cmd run build
npm.cmd test
# This next command uses a bounded real native Codex inference, not a fake worker:
npm.cmd run smoke
# Start the interactive Claude lead and native Remote Control:
.\scripts\start-pilot.ps1
```

The launch script creates only .local/mcp.json in this project and starts Claude in fixtures/pilot. Review and accept native trust/Remote Control prompts yourself. It does not approve tools, change global settings or bypass permissions. In Claude use /mcp to confirm coding_hub is connected. Open the native Remote Control link/QR in the signed-in Claude iPhone app; never publish that pairing link.

## Repo mode: real projects, parallel workers

```powershell
.\scripts\start-pilot.ps1 -Repo C:\path\to\your\repo -MaxWorkers 3
```

The lead runs in your repo. Each `start_worker` creates a git worktree under `.local\worktrees` on a new `hub/<id>` branch off the repo's current HEAD, so workers never touch your checkout or each other. Up to `MaxWorkers` run at once. Flow: `start_worker` → `wait_for_worker` → `get_worker_diff` → `commit_worker_changes` (commits to the worker's branch only) → you or Claude merge with normal permissions → `remove_worker_workspace`.

The hub runs git outside the sandbox on a folder the worker could edit, so host-side git always uses the gitdir recorded before the worker started (never the worktree's `.git` pointer) and disables hooks, fsmonitor and external diff drivers. `tests/repo.test.mjs` covers a worker rewriting a repo hook and a worker redirecting `.git` to a gitdir it planted; both attacks succeed against plain git. Remaining trust: clean/smudge filters you have configured yourself (such as Git LFS) still run on worker-written files that select them. Repos that track symlinks are refused.

Tasks and decisions are stored in `.local\hub.sqlite`. `list_workers` and `get_task_history` survive restarts; a task that was active when the hub stopped is reported `interrupted`, and its worktree can still be diffed, committed or removed.

## What to test from the iPhone

1. Ask Claude: `Call coding_hub test_phone_form. This is only a synthetic rendering check; do not run a worker.` Choose decline, then repeat and choose allow-once, typing phone-test. No command executes in either synthetic test.
2. Ask: `Use start_worker to ask Codex to summarize this fixture README without changing files. Use wait_for_worker to bring its result back here.` Confirm useful output in this same conversation.
3. Ask Claude to implement a small meaningful component itself: `Design and implement a dependency-free task-status formatter in this fixture. You own its API, implementation and checks. Then give Codex a bounded independent review task through coding_hub, explain why that review helps, assess its findings, and make any fixes yourself.` This proves Claude does substantive engineering while Codex contributes a distinct task.
4. Test a REAL Codex approval separately: ask Claude to delegate one explicitly described harmless command that Codex requests permission for, then call wait_for_worker. The form must say REAL CODEX APPROVAL and show the exact provider command, directory and requested access. Do not claim the flow passed if Codex never requests permission. Choose decline first; task must stop. For the next fresh task approve once; verify only that exact action. Do not approve arbitrary extra access to force a demonstration.
5. Test a real worker question when available. The native question form must be answered by you, not Claude tool arguments. Synthetic UI tests alone do not prove worker question delivery.
6. Start a bounded task, lock/disconnect the phone, reconnect and inspect it. Start another, cancel it while a decision is pending, then ensure a late response cannot restart the task. Test a wait longer than two minutes to evaluate Claude's native background completion notification; until observed, automatic wake-up remains unverified.

Record each pass/fail with phone model/app version, date, exact test and observed behavior in docs/phone-results.md. Terminal-only completion does not count as phone approval success. If a required form cannot be shown or a completion cannot resume the lead, document the exact case before considering another interface.

## Boundaries and honest limitations

- In fixture mode one worker at a time edits the dedicated fixture; in repo mode each worker gets its own worktree. Workers cannot select a different directory through the MCP tools. Local environment configuration is trusted host setup. Filesystem links/junctions inside the fixture are refused during startup. A working folder is not OS isolation; native Codex sandbox enforcement still matters.
- Provider startup forces OpenAI/ChatGPT login and verifies the returned account type. It omits API keys from the worker environment and disables native plugins, hooks, notification commands, browser/computer tools, apps and additional agents. It discovers and disables inherited MCP servers and refuses inference unless the thread inventory is empty and required sandbox/user-approval settings were retained. Native Codex still uses its own supported account storage; no credentials are read by our application.
- Approvals and questions use actual MCP form elicitation. No model-facing approval/answer endpoint exists. Native client hooks or an untrusted client could still auto-answer forms; do not enable auto-answer hooks for this pilot. The app cannot cryptographically prove a client response came from a human.
- Command approvals require a reviewable command/directory and available accept-once decision. Network-policy-only requests are unsupported. File approvals require a matching captured exact patch; persistent grantRoot requests are refused. Other request kinds fail closed. Denial stops the whole task to avoid automatic rephrased retries.
- Tasks continue between individual MCP calls while the MCP process lives. Task history is durable, but live workers are not: exiting Claude, terminating the MCP server or host sleep stops them, and they are reported interrupted on restart rather than resumed. On Windows a worker orphaned by a hub crash may keep running until you end it. There is a 10-minute worker deadline and 20-task session limit.
- A completed provider turn is a worker report, not proof that project checks passed. Claude owns integration and verification.
- Tests use a fake Codex protocol process and real MCP transport. They verify adapter behavior but cannot prove native sandbox enforcement, subscription entitlement or iPhone rendering. scripts/smoke.mjs uses real Codex for read-only inference and declines unexpected approval requests; actual human accept-once must be tested on the phone.

See [phone test results](docs/phone-results.md) and [Claude's lead responsibilities](fixtures/pilot/CLAUDE.md).

Regenerate installed schemas when upgrading Codex: codex app-server generate-ts --out protocol --experimental. Generated schemas are local verification inputs and ignored by Git.

### Exact harmless real-approval probe

Send this to the Claude lead after the synthetic form and read-only worker tests:

> Ask Codex to request explicit human permission (`sandbox_permissions=require_escalated`, with no prefix_rule or remembered policy amendment) before running only PowerShell `Write-Output 'coding-hub-approval-test'` in the disposable fixture, solely to test delegated consent. Call wait_for_worker so I can answer the real native form. If Codex does not emit a real permission request, report the test as inconclusive; do not substitute a simulated approval. After a decline, stop. On a fresh task after approve-once, check the output happened exactly once.

The exact provider request must appear in the human form. This request is deliberately small and produces console text only; it does not install packages, access the network, write a file or grant a remembered command policy.
