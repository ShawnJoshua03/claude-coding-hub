# Boundaries and limitations

Carried over from the original pilot README. See also the [threat model](threat-model.md).


- In fixture mode one worker at a time edits the dedicated fixture; in repo mode each worker gets its own worktree. Workers cannot select a different directory through the MCP tools. Local environment configuration is trusted host setup. Filesystem links/junctions inside the fixture are refused during startup. A working folder is not OS isolation; native Codex sandbox enforcement still matters.
- Provider startup forces OpenAI/ChatGPT login and verifies the returned account type. It omits API keys from the worker environment and disables native plugins, hooks, notification commands, browser/computer tools, apps and additional agents. It discovers and disables inherited MCP servers and refuses inference unless the thread inventory is empty and required sandbox/user-approval settings were retained. Native Codex still uses its own supported account storage; no credentials are read by our application.
- Approvals and questions use actual MCP form elicitation. No model-facing approval/answer endpoint exists. Native client hooks or an untrusted client could still auto-answer forms; do not enable auto-answer hooks for this pilot. The app cannot cryptographically prove a client response came from a human.
- Command approvals require a reviewable command/directory and available accept-once decision. Network-policy-only requests are unsupported. File approvals require a matching captured exact patch; persistent grantRoot requests are refused. Other request kinds fail closed. Denial stops the whole task to avoid automatic rephrased retries.
- Tasks continue between individual MCP calls while the MCP process lives. Task history is durable, but live workers are not: exiting Claude, terminating the MCP server or host sleep stops them, and they are reported interrupted on restart rather than resumed. On Windows a worker orphaned by a hub crash may keep running until you end it. There is a 10-minute worker deadline and 20-task session limit.
- A completed provider turn is a worker report, not proof that project checks passed. Claude owns integration and verification.
- Tests use a fake Codex protocol process and real MCP transport. They verify adapter behavior but cannot prove native sandbox enforcement, subscription entitlement or iPhone rendering. scripts/smoke.mjs uses real Codex for read-only inference and declines unexpected approval requests; actual human accept-once must be tested on the phone.

See [phone test results](docs/phone-results.md) and [Claude's lead responsibilities](fixtures/pilot/CLAUDE.md).

Regenerate installed schemas when upgrading Codex: codex app-server generate-ts --out protocol --experimental. Generated schemas are local verification inputs and ignored by Git.

