# Phone testing checklist

**Status: the phone path does not work today.** On 2026-10-19 the native Remote Control session paired with an iPhone and tool-permission prompts reached the phone, but the MCP **approval forms did not render there** (two attempts; details in [phone-results.md](phone-results.md)). Approvals therefore happen in the desktop or terminal client. This checklist is kept so the test can be repeated if Remote Control starts showing MCP forms.

Record each result in [phone-results.md](phone-results.md): phone model and app version, date, exact test, observed behaviour. Terminal-only completion does not count as phone success.

## What to test from the iPhone

1. Ask Claude: `Call coding_hub test_phone_form. This is only a synthetic rendering check; do not run a worker.` Choose decline, then repeat and choose allow-once, typing phone-test. No command executes in either synthetic test.
2. Ask: `Use start_worker to ask Codex to summarize this fixture README without changing files. Use wait_for_worker to bring its result back here.` Confirm useful output in this same conversation.
3. Ask Claude to implement a small meaningful component itself: `Design and implement a dependency-free task-status formatter in this fixture. You own its API, implementation and checks. Then give Codex a bounded independent review task through coding_hub, explain why that review helps, assess its findings, and make any fixes yourself.` This proves Claude does substantive engineering while Codex contributes a distinct task.
4. Test a REAL Codex approval separately: ask Claude to delegate one explicitly described harmless command that Codex requests permission for, then call wait_for_worker. The form must say REAL CODEX APPROVAL and show the exact provider command, directory and requested access. Do not claim the flow passed if Codex never requests permission. Choose decline first; task must stop. For the next fresh task approve once; verify only that exact action. Do not approve arbitrary extra access to force a demonstration.
5. Test a real worker question when available. The native question form must be answered by you, not Claude tool arguments. Synthetic UI tests alone do not prove worker question delivery.
6. Start a bounded task, lock/disconnect the phone, reconnect and inspect it. Start another, cancel it while a decision is pending, then ensure a late response cannot restart the task. Test a wait longer than two minutes to evaluate Claude's native background completion notification; until observed, automatic wake-up remains unverified.

Record each pass/fail with phone model/app version, date, exact test and observed behavior in docs/phone-results.md. Terminal-only completion does not count as phone approval success. If a required form cannot be shown or a completion cannot resume the lead, document the exact case before considering another interface.


### Exact harmless real-approval probe

Send this to the Claude lead after the synthetic form and read-only worker tests:

> Ask Codex to request explicit human permission (`sandbox_permissions=require_escalated`, with no prefix_rule or remembered policy amendment) before running only PowerShell `Write-Output 'coding-hub-approval-test'` in the disposable fixture, solely to test delegated consent. Call wait_for_worker so I can answer the real native form. If Codex does not emit a real permission request, report the test as inconclusive; do not substitute a simulated approval. After a decline, stop. On a fresh task after approve-once, check the output happened exactly once.

The exact provider request must appear in the human form. This request is deliberately small and produces console text only; it does not install packages, access the network, write a file or grant a remembered command policy.
