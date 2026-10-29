# jubividia — working agreement for Claude Code

Self-hosted LTX-2.5 video generation on RunPod Serverless. The full product/technical spec is in `SPEC.md`. Read it before doing anything.

## How work is organised

Every feature goes through a fixed sequence of **separate subagents** (defined in `.claude/agents/`). The main session is the coordinator: it breaks the spec into features, dispatches agents in order, relays questions to Ken, and never implements features itself.

```
feature request
   │
   ▼
[architect]  ── assesses design, classifies decisions as one-way / two-way doors
   │
   ├─ any one-way door? ──► [reviewer] second opinion on that decision ──┐
   │                                                                      │
   │          decision needs Ken? ──► STOP, ask Ken, wait ◄───────────────┘
   ▼
[engineer]   ── implements exactly the approved design, on a feature branch
   │
   ▼
[validator]  ── tests, runs, pokes holes; questions anything in doubt
   │
   ├─ problems? ──► back to [engineer] (or [architect] if it's a design flaw)
   ▼
coordinator reports to Ken; Ken merges
```

### Roles

| Agent | Job | Must NOT |
|---|---|---|
| `architect` | Assess the feature before any code: approach, interfaces, risks. Classify every non-trivial decision as **one-way door** or **two-way door**. Write a short design note to `docs/decisions/<feature>.md`. | Write implementation code |
| `reviewer` | Independent second opinion on each **one-way door** the architect flagged. Argue the alternatives, then agree or dissent with reasons. | Rubber-stamp; be the same agent instance as the architect |
| `engineer` | Implement the approved design. Small commits, feature branch, no scope creep. | Change the design; make one-way-door decisions; mark own work done |
| `validator` | Independently test and validate the engineer's work against the spec and the design note. Run it. Try to break it. Question anything in doubt, in writing. | Fix the code itself; accept "it should work" without running it |

### One-way vs two-way doors

- **One-way door**: expensive or impossible to reverse later. Examples here: choice of cloud platform, GPU type, model variant, storage layout on the network volume, R2 bucket/key schema, public API contract of the worker handler, auth model, anything that costs real money to redo. → architect **and** reviewer, then Ken confirms if not already fixed in `SPEC.md` §2.
- **Two-way door**: cheap to change. Examples: internal module layout, which HTTP client, log format, UI styling, variable names. → architect alone decides; engineer proceeds.
- If unsure which it is, treat it as one-way.

### Decisions already made

`SPEC.md` §2 lists decisions Ken has already taken (platform, GPU = RTX A6000 + A40 only, model variant, storage, front end, auth). Agents do not relitigate these. If an agent believes one is wrong, it says so to the coordinator with evidence; the coordinator asks Ken; nobody silently deviates.

### Talking to Ken

- Per `SPEC.md` §1a: anything not fixed in §2, anything that turns out wrong/outdated, anything that changes cost → **stop and ask**, with options, one-line trade-offs, and a recommendation.
- Batch questions per feature where possible; don't drip-feed.
- Small implementation details: just decide.

## Conventions

- Branch per feature: `feat/<short-name>`. Never commit directly to `main`.
- Commit messages: imperative, one line + optional body. Design notes and validation reports are committed alongside the code they describe.
- Secrets never enter the repo. `config.env` and `.env*` are git-ignored; `config.env.example` documents every variable.
- Validation report for each feature goes in `docs/validation/<feature>.md` (what was run, what passed, what's in doubt).
- Keep `README.md` current: setup from zero, daily usage, measured cold/warm times, cost.

## Feature order (from SPEC.md §4)

1. `worker` — serverless worker image + handler
2. `models` — download script, volume layout
3. `workflows` — t2v / i2v / v2v API-format JSON + node-ID docs
4. `endpoint` — RunPod serverless endpoint + volume (infra)
5. `ui` — Cloudflare Worker front end + Access
6. `cost` — usage script, per-clip cost in UI
7. `dev-pod` — optional, last

Each starts with the architect. Do not start feature N+1's engineering before feature N's validation is accepted, unless Ken says otherwise.
