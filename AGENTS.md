# Instructions for coding agents (Copilot, Codex, others)

This repo is a local MCP hub that lets a Claude Code lead delegate work to coding workers while a human approves every risky action. Read README.md first. A mistake in the approval, cancellation or git-isolation code can let a worker act without the human's consent, so some files are off limits.

## Do not edit (ask the human; a Claude Opus session owns these)

- `src/task.ts` (approval, deny, cancel and process-cleanup rules)
- `src/worker.ts` (Codex protocol translation and its login/sandbox checks)
- `src/workspace.ts` (git worktrees and the hook/pointer protections)
- The approval and elicitation logic in `src/server.ts` (`present`, `wait_for_worker`, `stoppedWorkspace`)
- Anything that loosens a sandbox, login check, approval requirement or the list of environment variables passed to workers (`filteredEnvironment`)
- `tests/safety.test.mjs` and the attack tests in `tests/repo.test.mjs` (add tests, never weaken or delete them)

## Good tasks for you

- A new provider adapter as a NEW file that extends `BaseTask` from `src/task.ts` (for example OpenCode with a Gemini API key). Register it in the `providers` map in `src/server.ts`; that one-line change is allowed. Requirements: human-only approvals through the base class, a filtered environment, no inherited credentials, no network or file access beyond the task folder unless the human approves.
- Tests for `src/store.ts` and the `list_workers` / `get_task_history` tools.
- Documentation, the iPhone checklist in `docs/phone-results.md` (do not mark a row passed; only the human can), and `.gitattributes` for line endings.

## Rules

- Work on a new branch, never `main`. Do not push, merge or rewrite history.
- Before reporting done run `npm run build && npm test` and paste the real result, including failures. All tests must pass (47 at the time of writing). Run them outside any sandbox that blocks `taskkill` or process-group kill: the hub fails closed when it cannot confirm a worker stopped, and tests then fail or hang.
- Never add, print or commit API keys, tokens or `.local/`. Provider keys come from the human's environment only.
- Keep changes small and say which files you touched. Do not add dependencies without asking.
- If a task seems to require editing an off-limits file, stop and explain instead.
