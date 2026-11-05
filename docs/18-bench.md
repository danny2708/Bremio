# 18 — bremio-bench

**Purpose:** a fixed, repeatable answer to "does Bremio resolve the task?"
(`docs/17` P1). Every later capability (P2 closed loop, P3 real tools, the gate
before P4) is judged by its delta on this suite, not by how it looks.

> ⚠️ **Quota.** `bremio bench run` performs one full agent run per case — a
> Team case is a lead plan plus several worker tasks. Twelve cases cost what
> twelve real `bremio run`s cost. `bremio bench check` and the test suite spend
> nothing. CI never runs the bench on push or PR (see below).

## Layout of a case

```
bench/cases/<id>/
  case.json            definition (validated by @bremio/bench BenchCaseSchema)
  repo/                the starting repository — all the agent ever sees
  hidden/__bench__/    verification files, copied in only after the agent finishes
  solution/            reference solution, overlaid on repo/ by the self-check
```

`case.json`:

```json
{
  "schemaVersion": 1,
  "id": "js-bugfix-range",
  "title": "range() drops its inclusive end",
  "category": "bug-fix",
  "language": "javascript",
  "prompt": "…exactly what the agent receives…",
  "verify": [{ "command": "node", "args": ["--test", "__bench__/range.test.mjs"] }],
  "timeoutSec": 600,
  "costBudgetUsd": 0.5
}
```

- `category`: `bug-fix | feature | refactor | test-writing | multi-file | docs`.
- `language`: `javascript | typescript | python`. TypeScript runs through Node's
  type stripping (`--experimental-strip-types`), so case code must avoid enums
  and parameter properties. Python cases use only the standard library.
- `verify` is **argv, never a shell string**. `node` resolves to the running
  Node binary; `python` resolves to `BREMIO_BENCH_PYTHON`, else `python3`, else
  `python`. Every command must exit 0.
- `costBudgetUsd` is recorded against provider-reported cost (`overBudget`); it
  is never enforced mid-run.

Rules the loader enforces (a case that breaks them does not load):

- hidden files live under `hidden/__bench__/`; the runner deletes
  `__bench__/` in the workspace before installing them, so anything an agent
  planted there is discarded;
- `repo/` contains neither `__bench__/` nor `.git/`;
- the prompt never mentions hidden verification;
- the directory name equals `id`.

## Adding a case

1. Create the four parts above. Keep it small, deterministic, offline, and with
   no package installs.
2. Run `bremio bench check --cases <id>` (or `corepack pnpm test`): the
   **baseline must fail** hidden verification and **repo + solution must
   pass**. A case that fails either check measures nothing.
3. For test-writing cases, score the agent's tests by mutation: they must pass
   on the real code and fail on every mutant (see `js-tests-stack`).

## Running

```bash
corepack pnpm bremio bench check
```

```bash
corepack pnpm bremio bench run --mode single --agent claude --timeout 900
```

```bash
corepack pnpm bremio bench run --mode team --lead claude --worker codex --cases js-bugfix-range,py-feature-roman
```

```bash
corepack pnpm bremio bench report
```

```bash
corepack pnpm bremio bench report --compare <benchRunIdBefore> <benchRunIdAfter>
```

Run from the repository root (cases default to `./bench/cases`, results to
`./.bremio/bench/<benchRunId>.json`; override with `--cases-dir`/`--out-dir`).
Each case runs in a fresh temporary git repository; resolved workdirs are
removed, failed ones are kept and printed for inspection (`--keep` keeps all).

Per case, Single runs `runSingleAgent` directly in the workdir. Team runs
`runBremio`; if its quality gate **passed**, the completed task branches are
merged into base in plan order (what `bremio merge --run` does) before
verification. A red gate is verified as-is — Bremio's own rule is not to merge
it, so its changes do not count.

## What the numbers mean

| Field | Meaning |
|---|---|
| `resolved` | Every hidden verify command exited 0. The only success signal. |
| `runStatus` | Bremio's own view of the run. Can be `completed` while `resolved` is false — that gap is the point. |
| `qualityGate` | Team only: `passed`/`failed`/`not-run`; `n/a` for Single. |
| `gatePassRate` | Passed gates / cases whose gate ran. Compare with resolve rate to see whether the gate is trustworthy. |
| `usage.costUsd` | Sum of provider-reported cost over the run's task **and** coordination (planning) ledger entries. `null` = unknown: some entry had no cost. Never estimated. |
| `totalCostUsd` | Known only when every case's cost is known; otherwise `unknown`, with the partial known sum shown separately. |
| `wallTimeMs` | Whole case, including materialisation and verification. |

Each case also appends one line to `./.bremio/ledger.jsonl` with
`scope: "bench"`. `bremio stats`, net gain and calibration ignore that scope:
a bench case measures Bremio on a fixture, it is not work in your repository,
and it must never become routing evidence.

## Honesty limits

- The agent's workspace never contains hidden files and its prompt never names
  them, but agents run without an OS sandbox (`docs/17` P4). An agent that went
  looking on disk outside its workspace could find `bench/cases/`. Treat the
  suite as a measurement tool, not an adversarial one.
- Twelve cases are a seed. Small, single-language fixtures say little about
  large-repo work; add cases from real tasks and keep a held-out subset
  (`docs/17` R5).

## CI

`.github/workflows/bench.yml` runs **only** on `workflow_dispatch` and a weekly
schedule (Monday 03:17 UTC, Single/claude), never on push or pull request. It
needs repository secrets `ANTHROPIC_API_KEY` (Claude) and/or `OPENAI_API_KEY`
(Codex) and fails before spending anything if the selected agent's secret is
missing. Antigravity and OpenCode have no CI credential path and are refused.
Results are uploaded as the `bench-results-<run id>` artifact.

The Codex install/login step (`codex login --with-api-key`) has not been
exercised in CI yet; verify it on the first dispatched run.
