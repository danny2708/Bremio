# 09 — OpenCode adapter

> **Status: unverified design.** Every claim below marked `❓` is a *hypothesis*
> to be confirmed against the installed binary before any adapter code is
> written. Task **S1-T1** in `docs/08-completion-plan.md` does that verification
> and rewrites this file with observed facts.
>
> This follows the standing rule in `docs/04`: the provider surfaces move faster
> than the docs, so verify, then code.

Installed locally: **opencode 1.18.4**, resolved at
`C:\Users\Acer\AppData\Roaming\npm\opencode`.

## Why OpenCode

`docs/06` Phase 6 lists OpenCode as an additional provider, and `docs/04`
already sketches it as "has a headless HTTP server → the adapter talks HTTP
instead of driving the TUI". Two things make it worth doing first among the
remaining work:

1. **It is a different integration shape.** Claude is an in-process SDK, Codex is
   a JSONL subprocess, Antigravity is a prose-only CLI. If OpenCode is an HTTP
   server with sessions, it exercises a fourth shape and proves `AgentAdapter`
   is genuinely provider-agnostic rather than accidentally fitted to three.
2. **It is the tool building this milestone.** Bremio integrating the agent that
   writes it produces first-hand knowledge of the surface that no amount of
   reading docs would.

## What the adapter must answer

Every provider in `docs/04` answers the same questions. These are the ones
S1-T1 must close, each with the probe that closes it.

### Surface ❓

Hypothesis: two usable surfaces exist — a one-shot `opencode run "<prompt>"` and
a headless `opencode serve` HTTP server with an official client SDK.

```powershell
opencode --help
opencode run --help
opencode serve --help
```

**Decide:** one-shot or server. Prefer the one that gives structured streaming
and clean cancellation. `docs/04` predicts HTTP; confirm rather than assume. A
server surface also raises a question the CLI ones do not: **who owns the server
process** — Bremio spawning one per run, or attaching to a user-run instance.

### Auth ❓

Hypothesis: `opencode auth login` stores credentials for a chosen provider, so
work bills to the user's existing subscription/key rather than anything Bremio
supplies.

**Decide:** what `healthCheck` can honestly assert. Antigravity's precedent
(`docs/04`) is instructive: there was no auth-status command, so the adapter
reads an onboarding state file as an explicit *heuristic* and says so. Never
report `ok` on a guess.

### Workspace targeting ❗

The single most important check. Antigravity **ignores the spawned process cwd**
and writes into its own scratch workspace — a trap that would have silently
corrupted every worktree run had it not been caught.

```powershell
# in a scratch git repo, from a DIFFERENT cwd
opencode run "create a file called PROOF.txt containing the absolute path of your working directory"
```

**Decide:** does the process cwd control where files land, or is an explicit
directory flag / server-side path required? A worktree-isolated orchestrator
cannot use a provider that writes wherever it likes.

### Permission mapping ❓

Bremio has exactly two permissions (`docs/03`): `read-only` for reviewers and
test gates, `workspace-write` for implementers.

**Decide:** what enforces read-only. A config key, a flag, an agent profile, or
nothing. If nothing enforces it, OpenCode cannot hold review or test-gate roles
— the same conclusion `docs/04` reached for Antigravity, reached the same way.

### Streaming shape ❓

Hypothesis: structured events (JSON or SSE) rather than Antigravity's prose.

**Decide:** the mapping onto `AgentEvent` in `@bremio/protocol`. What is
available matters more than what is pretty: tool calls, token usage, model
identity, and a single unambiguous terminal event. If usage is reported, it
feeds the ledger; if the model id is confirmed, it fills `actualModel` — and if
neither is, both stay `unknown` rather than being inferred (`docs/05`).

### Structured output → lead eligibility ❗

An adapter is lead-eligible only when `planning === true` **and**
`structuredOutput === true` (`packages/adapter-sdk/src/capabilities.ts`). The
lead must return JSON matching `PlanSchema`.

**Decide:** can OpenCode be constrained to emit schema-valid JSON as its final
output? If yes it joins Claude and Codex in the lead pool, which is a genuine
capability increase. If only prompt-level coaxing is available, then
`structuredOutput = false` and it is a worker — the capability contract excludes
it from lead automatically, with no provider-specific branch anywhere in core.

### Cancellation ❓

**Decide:** does killing the process (or aborting the HTTP request) actually
stop the work, and does it leave orphans? This matters more than usual here: the
`ProcessSupervisor` contract is that `cancelled` is only reported once execution
is *confirmed* stopped, otherwise `cancellation_failed`. An HTTP surface may
need a cooperative settle handle, exactly like the Claude SDK path.

### Models ❓

Hypothesis: OpenCode is multi-provider and can list available models.

**Decide:** what `listModels()` returns, and how `reasoningLevel` maps. Per
`docs/05`, the adapter owns that mapping — core never names a model.

### Binary resolution ❓

Precedent: `BREMIO_AGY_BIN` overrides Antigravity's path. Do the same with
`BREMIO_OPENCODE_BIN`, resolving through PATH first. On Windows, npm global
installs produce a `.cmd` shim and no `.exe` — the extension shipped a bug over
exactly this (`apps/vscode-extension/src/cli-launcher.ts` has the fix and the
explanation). Reuse that approach; do not re-derive it.

## Findings

> **S1-T1 fills this in.** One row per question above, each with the command
> run and what was observed. Anything that could not be determined is recorded
> as "not available", never as an assumption.

| Question | Verdict | Evidence |
|---|---|---|
| Surface | *pending* | |
| Auth | *pending* | |
| Workspace targeting | *pending* | |
| Permission mapping | *pending* | |
| Streaming shape | *pending* | |
| Structured output | *pending* | |
| Cancellation | *pending* | |
| Models | *pending* | |
| Binary resolution | *pending* | |

## Resulting capability declaration

Fill in from the findings. Each boolean needs evidence, not optimism — an
overstated capability sends the router a task the provider cannot do.

```ts
{
  planning: /* ? */,           // lead-eligible only with structuredOutput
  structuredOutput: /* ? */,
  repositoryRead: /* ? */,
  repositoryWrite: /* ? */,
  shell: /* ? */,
  testing: /* ? */,            // needs reliable command exit codes
  browser: /* ? */,
  vision: /* ? */,
  resumableSessions: /* ? */,
}
```

`testing` deserves the same scrutiny Antigravity got: a test-gate agent must
surface **real shell exit codes**, because the quality gate is fail-closed on
them. Prose claiming "tests passed" is not evidence.

## Quota

Out of scope for this adapter. AI-Quota-Tray does not observe OpenCode, so
`@bremio/quota` reports OpenCode capacity as `unknown` — which the router
already handles as a soft penalty and never as a hard exclusion (`docs/05`).
Bremio does not build a second quota reader; that is R1 in `docs/99`.
