<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes â€” APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` â€” verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent orchestration (OpenCode + Orca)

This repository always uses a two-agent workflow. It applies to every agent session in this repo:

- `orchestrator` (GLM 5.3 Flash) is the primary agent. It owns planning, decomposition, acceptance criteria, verification and gate decisions. It never edits implementation files.
- Implementation is delegated ONLY to the `executor` subagent (Qwen 3.6) via a bounded work contract containing: objective, context, inputs, allowed_files, forbidden_files, constraints, tests, success_criteria, deliverables.
- The orchestrator never trusts an executor summary as evidence: it inspects the actual diff and the actual test/check output before accepting.
- Ticket-driven work runs through Orca: `.\scripts\orca-local.ps1` (always use the launcher; it wires `.orca-tools\bin` into PATH). Ticket tags: `needs-plan`, `ready-for-work`, `ready-for-review`, `blocked`, `needs-human-decision`, `verified`.
- Never bypass the orchestrator/executor split. Do not create parallel agent configs; `opencode.jsonc` is the single source of truth (merging the kit agents with the repo NaN/InferX providers).

Kit provenance: configuration scaffold adapted from a private internal orchestration kit (OpenCode + Orca two-agent workflow).
