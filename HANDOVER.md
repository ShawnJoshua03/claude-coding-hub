# Handover

State as of 2026-11-01, branch `portfolio-polish` (pushed, not merged).

## Goal
Make the repo a portfolio piece, and let the hub control more workers than Codex and OpenCode+Gemini.

## Done
- Shared ACP base (`src/acp.ts`) and new workers: `gemini` (`src/gemini.ts`), `grok` (`src/grok.ts`), `openrouter` (profile in `src/opencode.ts`).
- Docs: README, threat model, architecture, providers, limitations. MIT `LICENSE`, Windows CI, `npm run demo` and `docs/demo.gif`.
- 65/65 tests pass (`npm.cmd test`, about 90 seconds). A real Codex smoke run passed on 2026-11-01.

## Not verified against real CLIs
- `gemini`: handshake and isolated start only. The stored `GEMINI_API_KEY` is rejected by Google (401), so a new key is needed.
- `grok`: handshake only. Run `scripts/grok-login.ps1` once to sign in to the hub-owned home.
- `openrouter`: simulated agent only. Needs `OPENROUTER_API_KEY`.
- Phone approval does not work (MCP forms never rendered on iPhone Remote Control).

## Open items
- Ollama is unsupported on purpose (reasons in `docs/providers.md`).
- Symlink refusal has no dedicated test.
- `docs/demo.gif` has no title frame (it starts at the approval form).
- CI has not been seen running on GitHub yet.

## Next steps (the owner does these)
1. Open the PR: https://github.com/ShawnJoshua03/claude-coding-hub/pull/new/portfolio-polish
2. Check CI, then merge to `main`.
3. Read the rendered README once (diagrams and GIF).
4. Switch the repo to public: Settings, General, Danger Zone.

## Rules for agents
Read `AGENTS.md` first. It lists the files that are off limits and why.
