# jubividia — working agreement for Claude Code

Self-hosted LTX-2.5 video generation on RunPod Serverless. The full product/technical spec is in `SPEC.md`. Read it before doing anything.

## Workflow

This repo uses Anthropic's official **feature-dev** workflow, vendored into `.claude/` (see `.claude/NOTICE.md`). Every feature is built by running:

```
/feature-dev <feature name or description>
```

That command drives seven phases — Discovery → Codebase Exploration (parallel `code-explorer` agents) → Clarifying Questions → Architecture Design (parallel `code-architect` agents proposing different approaches) → Implementation → Quality Review (parallel `code-reviewer` agents) → Summary — and pauses for Ken at the clarifying questions, the architecture choice, and before implementation. Follow it as written; don't skip phases.

For pull requests, `/code-review` runs the official parallel review.

## Project rules that apply inside every phase

- **`SPEC.md` §2 decisions are fixed**: RunPod Serverless, GPU = RTX A6000 + A40 only, LTX-2.5 distilled FP8/int8, network volume for models, R2 for outputs, Cloudflare Worker + Access front end. The architecture phase designs *within* these; it does not propose alternatives to them. If something in §2 turns out to be impossible or clearly wrong, raise it in the clarifying-questions phase with evidence and let Ken decide.
- **`SPEC.md` §1a — discuss before deciding**: anything not fixed in §2, anything outdated, anything that changes cost → ask, with options, one-line trade-offs, and a recommendation. Batch questions per feature. Small implementation details: just decide.
- **Verify external facts** during exploration/design: current LTX-2.5 model filenames and folders, ComfyUI-LTXVideo node names, RunPod serverless API and worker templates, Cloudflare APIs. Don't design on assumptions a search would settle.
- **Branch per feature** `feat/<name>`; never commit to `main`. Ken merges.
- **Secrets never enter the repo.** `config.env` and `.env*` are git-ignored; `config.env.example` documents every variable.
- **Keep `README.md` current**: setup from zero, daily usage, measured cold/warm times, cost.
- Record each feature's Phase 7 summary (what was built, key decisions, files) in `docs/decisions/<feature>.md`.

## Feature order (from SPEC.md §4)

1. `worker` — serverless worker image + handler
2. `models` — download script, volume layout
3. `workflows` — t2v / i2v / v2v API-format JSON + node-ID docs
4. `endpoint` — RunPod serverless endpoint + volume (infra)
5. `ui` — Cloudflare Worker front end + Access
6. `cost` — usage script, per-clip cost in UI
7. `dev-pod` — optional, last

Finish one feature's quality review before starting the next, unless Ken says otherwise.
