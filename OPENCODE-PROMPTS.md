# OpenCode prompt pack — Bremio alpha → v1.0

Twenty prompts, in order. Paste one into opencode, let it finish, verify the
commit landed, paste the next.

**Single source of truth is `docs/08-completion-plan.md`.** Each prompt points at
its task section there and restates only the constraints that must not be missed.
If a prompt and the doc ever disagree, the doc wins — that is why the prompts
point rather than duplicate.

---

## Before the first prompt

Run once, yourself:

```powershell
cd D:\Work\Side-Projects\Bremio
git checkout -b sprint/opencode-completion
```

`main` stays at the released alpha. Everything below happens on the branch.

## Between prompts

After each one, confirm the task actually landed:

```powershell
git log --oneline -1
git status --short          # expect clean
```

At the end of each sprint, before starting the next:

```powershell
corepack pnpm release:check
```

If `release:check` fails at a sprint boundary, paste prompt **FIX** (bottom of
this file) before continuing.

---

# Sprint 1 — OpenCode as a first-class provider

## S1-T1 — Verify the OpenCode automation surface

```text
Read docs/10-delegation-contract.md and docs/08-completion-plan.md section
"S1-T1" in full before starting. Follow the delegation contract for the whole
sprint; it is the working agreement and I will not repeat it in later prompts.

Task S1-T1. This is a VERIFICATION task, not a coding task. Do not write any
source code.

Goal: replace every hypothesis in docs/09-opencode-adapter.md with an observed
fact about the installed opencode 1.18.4.

Probe the real binary for each question marked with a question mark or an
exclamation mark in docs/09: surface (one-shot vs headless server), auth,
workspace targeting, permission mapping, streaming shape, structured output,
cancellation, model listing, and binary resolution. Record the exact command you
ran and what you observed.

Three things matter most:

1. Workspace targeting. Do this in a throwaway git repo, invoked from a
   DIFFERENT working directory, and answer definitively whether the process cwd
   controls where files are written. Antigravity ignores cwd entirely and writes
   into its own scratch workspace; if opencode does the same, an adapter written
   from assumptions would silently corrupt every worktree run.

2. Structured output. End with an explicit yes or no on lead eligibility, backed
   by evidence. An adapter is lead-eligible only when it can be constrained to
   emit JSON matching PlanSchema.

3. Anything you cannot determine is recorded as "not available". Never write an
   assumption in the findings table.

Fill in the Findings table and the capability declaration block in
docs/09-opencode-adapter.md. Create SPRINT-LOG.md at the repo root with your
first entry, in the format given in docs/10 section 6.

Commit only docs/09-opencode-adapter.md and SPRINT-LOG.md, with the subject:
docs(opencode): record the verified automation surface
```

## S1-T2 — Implement `packages/adapter-opencode`

```text
Task S1-T2. Read docs/08-completion-plan.md section "S1-T2" for the full success
criteria, and your own findings in docs/09-opencode-adapter.md.

Build packages/adapter-opencode implementing the AgentAdapter contract in
packages/adapter-sdk/src/adapter.ts. Mirror the scaffolding of
packages/adapter-antigravity exactly: package.json with @bremio/adapter-sdk and
@bremio/protocol as workspace:*, tsconfig.json extending ../../tsconfig.base.json,
src/, test-fixtures/.

Non-negotiable:

- No capability boolean is true without a finding in docs/09 behind it. An
  overstated capability sends the router a task the provider cannot do.
- startRun emits exactly one terminal completed event, on both the success and
  the failure path, and nothing after it.
- cancelRun is idempotent and safe before start and after completion.
- Binary resolution honours BREMIO_OPENCODE_BIN, then PATH. On Windows an npm
  global install produces a .cmd shim and no .exe. Reuse the approach in
  apps/vscode-extension/src/cli-launcher.ts rather than re-deriving it; that bug
  has already been paid for once.
- Errors map onto the existing classification in packages/adapter-sdk/src/errors.ts.

Write src/opencode-adapter.test.ts covering the five cases listed in docs/08,
using recorded fixtures under test-fixtures/ the way adapter-codex does. Record
real output as the fixture; do not hand-write what you wish the provider emitted.

Append your SPRINT-LOG.md entry. Commit with the subject:
feat(adapter-opencode): add the OpenCode provider adapter
```

## S1-T3 — Offer OpenCode everywhere an agent is chosen

```text
Task S1-T3. Read docs/08-completion-plan.md section "S1-T3".

Register the OpenCode adapter in every surface that enumerates agents. The six
places are listed in the doc with line hints: apps/cli/src/index.ts (help text,
the agentIds set, worker validation), apps/daemon/src/server.ts,
apps/cli/src/tui/data.ts, apps/vscode-extension/src/webview.ts, and
scripts/provider-smoke.ts.

Two criteria are easy to miss:

- After your change, `grep -rn '"claude", "codex", "antigravity"'` over apps/ and
  packages/ must return nothing. No hardcoded three-agent triple survives.
- If S1-T1 found OpenCode is not lead-eligible, then `--lead opencode` must be
  rejected by the existing capability contract, NOT by a name check. Core must
  not learn provider names.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit
with the subject:
feat(opencode): offer OpenCode everywhere an agent is chosen
```

## S1-T4 — Prove OpenCode with a real run

```text
Task S1-T4. Read docs/08-completion-plan.md section "S1-T4".

Run the provider smoke against the real OpenCode provider:
  corepack pnpm smoke:providers --agent opencode

This consumes real quota, which is the point: every other adapter in this
project was accepted only after a real run. Fixtures prove parsing, not that the
provider does what the adapter believes.

Confirm a file was actually created in the target repo, and that a report and a
ledger entry exist. Then run one Team run: with --lead opencode if S1-T1 found it
lead-eligible, otherwise with --worker opencode.

Rewrite the OpenCode section of docs/04-adapters.md as a full verified section in
the same shape as the Antigravity one above it, and update the Phase 6 status in
docs/06-roadmap.md.

Paste the run ids and the observed output into SPRINT-LOG.md. If the real run
fails and you cannot make it pass honestly, record the blocker per docs/10
section 7 and stop — do not fake the evidence.

Commit with the subject:
docs(adapters): promote OpenCode from future to verified
```

**Sprint 1 gate:** `corepack pnpm release:check`

---

# Sprint 1R — Remediation

Added after reviewing sprint 1. Run these before sprint 2.

## S1-R1 — Replace the hand-written fake with recorded reality

```text
Task S1-R1. Read docs/08-completion-plan.md section "S1-R1" and the updated test
policy in docs/10-delegation-contract.md section 5.

test-fixtures/fake-opencode.mjs is hand-written, so it asserts what the adapter
already believes. During S1-T4 the full suite stayed green through three rounds
of live debugging in which the adapter could not parse a single real response:
first data.info.structured_output, then info.text, and only then the real
parts[].text. A fixture that cannot be wrong cannot catch a bug.

Capture real output and commit the bytes: one `opencode run --format json`
stream, and one POST /session/:id/message response body from a live
`opencode serve`. Redact anything user-specific; keep the shape byte-exact.
Test the event mapper and the server-response parser against those recordings.

The server/lead path currently has NO tests at all — which is exactly why the
path that broke three times was the one nothing covered. Give it tests.

Then verify each new test can fail: point the parser at the wrong field, confirm
red, restore. Note it in SPRINT-LOG.md.

Commit:
test(adapter-opencode): parse recorded provider output, not a guess
```

## S1-R2 — Make the structured-output claim true or drop it

```text
Task S1-R2. Read docs/08-completion-plan.md section "S1-R2" and
docs/10-delegation-contract.md section 6c.

The adapter declares structuredOutput: true and planning: true, which makes
OpenCode lead-eligible. But S1-T4 removed the format: json_schema request after
the default provider rejected it. Nothing constrains the output now — the lead
returns valid plan JSON because one free model complied when asked in prose.
That is evidence about a model, not a property of the adapter, and the router
acts on that boolean as a promise.

Choose (a) or (b) from docs/08 and say in SPRINT-LOG.md which and why:

(a) Earn it — validate the final output against req.outputSchema and FAIL the
    run when it does not match, so a completed run guarantees schema-valid
    output. Try the @opencode-ai/sdk structured-output path; it may work where
    the raw HTTP format field did not. Test that a non-conforming response
    produces a failed outcome, not a completed one.

(b) Drop it — structuredOutput: false. OpenCode becomes a worker like
    Antigravity and the capability contract excludes it from lead with no name
    check anywhere.

Either way: vision: true has no probe behind it. Verify it or set it false. And
make docs/04 and docs/09 match whichever outcome you chose — docs/09 currently
says "Eligible to be the lead".

Commit:
fix(adapter-opencode): make the structured-output claim honest
```

## S1-R3 — Settle the shared review-prompt change

```text
Task S1-R3. Read docs/08-completion-plan.md section "S1-R3".

S1-T4 was a docs-only task. It edited packages/orchestrator/src/plan-schema.ts,
changing the review prompt for EVERY provider so that OpenCode's model would
emit parseable findings. It may well be an improvement — the old text referenced
an "output schema" it never showed. But it was untested, unrecorded as a
deviation, and it changed Claude's and Codex's review behaviour to fix a third
provider's problem.

Pin it with a test asserting the review prompt states the JSON shape that
parseReviewOutput in quality-gate.ts actually accepts, so that contract is
explicit rather than incidental.

Then verify it against Claude and Codex, not only OpenCode: one real Team run
each, gate passing, evidence in SPRINT-LOG.md. If either regresses, make the
instruction provider-conditional or revert it. Do not leave a cross-provider
change resting on one provider's evidence.

Commit:
test(orchestrator): pin the review prompt to the parser's contract
```

## S1-R4 — Make OpenCode worker-only, for real, everywhere

```text
Task S1-R4. Read docs/08-completion-plan.md section "S1-R4" and docs/10 in
full before starting.

Decision (final, not yours to revisit): OpenCode is a worker, not a lead
candidate. S1-R2 offered "earn structuredOutput:true or drop it"; S1-R3 did
neither cleanly — it removed the format:json_schema attempt and the
required-field check, but left the boolean at true. Set it to false.

docs/04-adapters.md, docs/06-roadmap.md and docs/09-opencode-adapter.md were
already corrected by hand to state the new verdict and the reasoning (the
provider's silent-empty-response failure mode, no repair loop unlike
lead-manager.ts's two attempts). Do not re-word them — your job is to make the
code match what they now say, and to fix the mechanism the claim depends on
everywhere it appears, not just the flag.

Concretely:
1. packages/adapter-opencode/src/opencode-adapter.ts: flip structuredOutput to
   false. Leave planning:true — that gates analysis-kind worker tasks and is
   unrelated to the lead role.
2. Update packages/adapter-opencode/src/opencode-adapter.test.ts and
   apps/cli/src/opencode-registration.test.ts, which currently assert
   structuredOutput === true.
3. apps/cli/src/index.ts: the existing `--lead` check
   (`errors.push("Team mode requires --lead 'claude', 'codex', or
   'opencode'")`) hardcodes opencode into a lead-name list. This is the exact
   thing S1-T3 said not to do ("rejected by the existing capability contract,
   not by a name check"). Fix it: keep a coarse "is this a known agent id"
   check with the general agentIds set (typo protection only, no per-provider
   enumeration in the message), then add a separate capability check — after
   `registry` is constructed, `await registry.get(leadId)!.getCapabilities()`
   and require `planning && structuredOutput` — with an error naming the
   missing capability. `--worker` is untouched.
4. scripts/provider-smoke.ts: narrow `type LeadId` to "claude" | "codex" and
   fix the `--lead` argument parsing and its error message to match. `AgentId`
   and `--agent`/`--worker` parsing keep accepting opencode.
5. Confirm `grep -rn '"claude", "codex", "opencode"' apps/ scripts/` finds no
   remaining lead-context match.

Verify: `bremio run --mode team --lead opencode --repo <path> "..."` is
rejected with a message naming the missing capability. `--worker opencode`
still works. `pnpm smoke:providers --lead opencode` throws while parsing
arguments, before any process spawns. `bremio doctor` shows OpenCode
lead-eligible: no.

Commit:
fix(opencode): stop treating opencode as lead-eligible
```

**Sprint 1R gate:** `corepack pnpm release:check`

---

# Sprint 2 — Routing completion

## S2-T1 — Move the tiered model policy into `config/routing.yaml`

```text
Task S2-T1. Read docs/08-completion-plan.md section "S2-T1" and
docs/05-quota-and-routing.md section "Router scoring".

Create config/routing.yaml plus packages/orchestrator/src/routing-config.ts with
a Zod schema, covering the capacityPolicy and routing blocks exactly as docs/05
specifies (healthy 50, limited 20, critical 5, reserveLeadCapacityPercent 15,
unknownQuotaPenalty 10), the scoring weights, and the tier table.

Two things carry the design:

- Tiers map reasoningRequirement (trivial through critical) to a PER-ADAPTER
  model id. A tier must never name one provider's model globally. docs/05 is
  explicit: model names are never hardcoded in core.
- An invalid config file fails loudly and names the offending path. It must
  never silently fall back to defaults — a wrong policy that looks applied is
  worse than a missing one. An ABSENT file is different: that yields the
  documented defaults.

When you are done, grep packages/orchestrator/src/*.ts for provider model id
literals. There must be none. No existing test may need editing to pass.

Write the four tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(routing): move the tiered model policy into config/routing.yaml
```

## S2-T2 — Map Antigravity buckets to verified model ids

```text
Task S2-T2. Read docs/08-completion-plan.md section "S2-T2" and the "Coverage
audit" section of docs/05-quota-and-routing.md.

AI-Quota-Tray persists Antigravity's display-derived bucket key, not a verified
provider model id, so Bremio currently marks those windows model-scoped with no
modelId and refuses to route on them. This is the last unchecked box in 4C.

Populate modelId through an EXPLICIT mapping table. Not a string transform, not
a regex, not a guess. An unknown key must leave modelId absent and stay
ineligible for routing: a new bucket appearing upstream must never silently
become a routing input.

Also verify the router picks the window for the CANDIDATE model — one limited
Antigravity model must not make every other Antigravity model unavailable.

Do not resurrect retired buckets; they stay dropped.

State in SPRINT-LOG.md where you put the mapping table and why. Tick the 4C box
in docs/05 only if every criterion actually holds. Write the four tests listed
in docs/08. Commit:
feat(quota): map Antigravity buckets to verified model ids
```

## S2-T3 — Score agents instead of assigning them positionally

```text
Task S2-T3. Read docs/08-completion-plan.md section "S2-T3" and
docs/05-quota-and-routing.md section "Router scoring", including the "Router
rules" list. This is the largest task in the sprint; read both fully first.

Implement the weighted router in packages/orchestrator/src/router.ts:
capability*0.30 + quota*0.25 + taskFit*0.20 + quality*0.15 + speed*0.05 +
preference*0.05, with weights read from config/routing.yaml (S2-T1), not inlined.

Hard rules, exactly as specified:
- -100 when the candidate authored the task under review and kind === "review"
- -40 when quota status is critical
- -Infinity when the task needs write and the agent lacks repositoryWrite

The load-bearing property, and the one most likely to be lost by accident: ONLY
fresh, high-confidence exhaustion may hard-exclude a candidate. Stale, unknown or
low-confidence quota applies unknownQuotaPenalty as a soft signal and can NEVER
be the sole reason an agent is excluded. This is what stops a dead AQT from
stopping all work in Bremio.

Also preserve: the lead capacity reserve, and the delegation guarantee that at
least one task reaches a different agent.

Scoring stays OPT-IN. The existing deterministic path remains the default until
enabled through config or --capacity-routing, and every existing router test must
pass unchanged — including a test asserting that with scoring disabled the
behaviour is identical to today.

Write a test per hard rule plus the four listed in docs/08. Commit:
feat(router): score agents instead of assigning them positionally
```

## S2-T4 — Finish the capacity observe-and-display surface

```text
Task S2-T4. Read docs/08-completion-plan.md section "S2-T4" and
docs/05-quota-and-routing.md section "Capacity surface".

Close the last two 4A boxes: manual refresh, native-usage links, and explicit
unavailable states, in apps/cli/src/quota.ts and the TUI capacity screen.

The honesty rules are the point of this task:
- An unavailable or unknown provider renders an explicit state WITH THE REASON.
  Never a blank row, never a fabricated percentage.
- Refresh states whether the result was LIVE or last-known, following the
  existing bremio capacity convention.
- openNativeUsage is ABSENT for providers with no native usage page — not
  present and broken.
- Do not regress the existing stale-labelling work. A stale window still leads
  with its age, not its percentage.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(capacity): finish the observe-and-display surface
```

**Sprint 2 gate:** `corepack pnpm release:check`

---

# Sprint 3 — Efficiency

## S3-T1 — Compute net gain against the single-agent baseline

```text
Task S3-T1. Read docs/08-completion-plan.md section "S3-T1" and
docs/05-quota-and-routing.md section "Efficiency model".

Create packages/orchestrator/src/net-gain.ts computing
net_gain = quota_saved_vs_baseline - orchestration_cost from the ledger in
packages/orchestrator/src/ledger.ts. Orchestration cost includes lead planning,
aggregation, handoff and escalation retries — the scope:"coordination" entries
already recorded.

The baseline is the BEST single-agent run for the same comparisonId. Not an
average, not an estimate.

The rule that makes this measurement rather than storytelling: any missing input
yields an explicit unknown. Never impute a price, never convert tokens into
subscription quota, never report a partial result as a number. Carry the reason
for the unknown so bremio stats can name the specific blocker.

Write the four tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(ledger): compute net gain against the single-agent baseline
```

## S3-T2 — Fall back to single-agent when coordination costs too much

```text
Task S3-T2. Read docs/08-completion-plan.md section "S3-T2" and
docs/05-quota-and-routing.md section "Guardrail & calibration gate".

Implement the kill-switch in packages/orchestrator/src/run.ts with its threshold
in config/routing.yaml. When measured orchestration overhead exceeds the
configured share of task cost, the run falls back to single-agent and records the
reason in the report.

The critical property: the switch is INERT when cost data is incomplete. It
fires on provider-reported numbers or not at all. A kill-switch triggering on an
estimate would abort good runs for imaginary reasons — that is worse than not
having one.

The fallback is surfaced to the user, never silent. State clearly in the code
comment at which point in the run the decision is made, and do not restart a run
already past the point where fallback is meaningful.

Write the four tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(orchestrator): fall back to single-agent when coordination costs too much
```

## S3-T3 — Report net gain and name every calibration blocker

```text
Task S3-T3. Read docs/08-completion-plan.md section "S3-T3" and
packages/orchestrator/src/calibration.ts.

Surface net gain in apps/cli/src/stats.ts: per comparison group and in
aggregate. unknown displays as unknown WITH ITS REASON — never as 0, never
hidden. A zero and an unknown mean completely different things here.

Each calibration blocker must name the specific missing dimension and how many
more samples are needed, not a generic "insufficient evidence". The single-agent
recommendation stays the fail-closed default until every threshold passes.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(stats): report net gain and name every calibration blocker
```

## S3-T4 — Collect paired evidence in one command

```text
Task S3-T4. Read docs/08-completion-plan.md section "S3-T4".

Add `bremio compare --repo <path> "<prompt>"`, running the Single baseline and
the Team flow with one shared generated comparisonId from the same tree state.
Reuse runSingleAgent and runBremio from packages/orchestrator/src/index.ts rather
than reimplementing either flow.

It must REFUSE on a dirty working tree, before either run starts. A controlled
comparison over a drifting tree is not evidence, and producing it anyway would
poison the calibration gate with junk samples.

Both run-scope ledger entries carry the correct flowMode and objective outcome.
Print the pair side by side including net gain when computable. Each side is
independently cancellable, and cancelling one leaves the other's ledger entry
coherent.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(cli): collect paired single-vs-team evidence in one command
```

**Sprint 3 gate:** `corepack pnpm release:check`

---

# Sprint 4 — Auto mode and escalation

## S4-T1 — Calibration-gated automatic mode selection

```text
Task S4-T1. Read docs/08-completion-plan.md section "S4-T1", plus the
"Execution modes" section of docs/06-roadmap.md.

Add `bremio run --mode auto`, choosing Single or Team.

The fail-closed property the whole design rests on: while calibration readiness
is insufficient-evidence, --mode auto ALWAYS chooses Single. No task shape, size
or keyword overrides this. An uncalibrated automatic router can make net_gain
negative, which is the escalation double-pay trap in docs/05.

Once readiness is ready, selection uses task shape plus capacity through a
CONFIGURABLE policy, not a hardcoded heuristic. The chosen mode and the reason
are recorded in the report and printed before execution. An explicit --mode
single or --mode team always wins. Auto is opt-in; the default mode is unchanged.

Write the four tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(cli): add calibration-gated automatic mode selection
```

## S4-T2 — User-approved escalation from Single to Team

```text
Task S4-T2. Read docs/08-completion-plan.md section "S4-T2" and risk R5 in
docs/99-risks-and-open-questions.md.

Offer escalation to Team after a Single run FAILS ITS VERIFICATION — not on any
failure signal the model reports about itself. A model's own claim that it
struggled is not evidence.

It never runs without explicit approval: --escalate up front, or an interactive
confirmation. Silence is not consent, and a non-interactive context without
--escalate does not escalate and says why.

The escalated run reuses the original prompt and joins the SAME comparison
group, so the ledger shows the combined cost of both attempts. Measuring
double-pay is the entire reason this feature is gated. Declining leaves the
Single result and its artifacts intact.

Write the four tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(orchestrator): offer user-approved escalation from single to team
```

## S4-T3 — Say why every automatic choice was made

```text
Task S4-T3. Read docs/08-completion-plan.md section "S4-T3".

Four kinds of automatic decision now exist: flow selection, agent scoring,
capacity exclusion, and kill-switch fallback. Each must carry a human-readable
reason stating the ACTUAL cause — "codex at 4% remaining, fresh", not "policy" —
and that reason must survive the daemon protocol round-trip and appear in the
CLI, the TUI and the VS Code panel.

No surface may display an automatic choice without its reason. A system that
silently routes work is one the user cannot trust or debug.

Reasons must never contain secrets, prompts or repository content. The redaction
rules in apps/cli/src/diagnostics.ts apply here too — reuse redactDeep rather
than writing a second redactor.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(ui): say why every automatic choice was made
```

## S4-T4 — Prove the fail-closed properties hold together

```text
Task S4-T4. Read docs/08-completion-plan.md section "S4-T4".

The fail-closed behaviour is now spread across the router, the calibration gate,
the kill-switch and escalation. Each has unit tests; nothing proves they hold IN
COMBINATION, which is exactly where safety properties die.

Write one integration test file under packages/orchestrator/src/ asserting all
six properties listed in docs/08, using the real router and real calibration
evaluation — do not mock the things under test.

Then do this, and record it in SPRINT-LOG.md: temporarily remove one guard,
confirm the corresponding assertion fails FOR THE RIGHT REASON, and restore it. A
test that passes whether or not the guard exists is worse than no test, because
it manufactures confidence.

Commit:
test: prove the fail-closed properties hold together
```

**Sprint 4 gate:** `corepack pnpm release:check`

---

# Sprint 5 — Hardening and v1.0

## S5-T1 — Guarantee the process tree dies with the run on Windows

```text
Task S5-T1. Read docs/08-completion-plan.md section "S5-T1",
packages/adapter-sdk/src/process-supervisor.ts, and the Known limitations
section of docs/07-operations.md.

taskkill /T /F walks the tree it can see at that instant, so a grandchild
spawned during the walk survives. The ProcessSupervisor contract is that
"cancelled" means confirmed stopped — a weaker termination undermines the
strongest correctness guarantee in this project.

Either use a Job Object for the real guarantee, or, if that requires a native
dependency this project should decline, implement a documented alternative that
closes the spawned-during-the-walk gap. If a new dependency is introduced, record
in SPRINT-LOG.md what it is and why nothing already present would do; this repo
chose node:sqlite over better-sqlite3 for exactly that reason.

Verify against a REAL three-level process tree on Windows: parent, child,
grandchild, all confirmed gone by pid after termination. Paste the pids before
and after into SPRINT-LOG.md. POSIX behaviour must be unchanged and its tests
must still pass.

Update docs/07 to whatever is now true — including "still a limitation, narrowed
to X" if that is the honest outcome. Do not tick a box you did not earn.

Commit:
fix(supervisor): guarantee the process tree dies with the run on Windows
```

## S5-T2 — Capacity cards and light-theme support in the panel

```text
Task S5-T2. Read docs/08-completion-plan.md section "S5-T2" and
apps/vscode-extension/src/webview.ts.

Add one capacity card per agent showing every window with its percentage, reset
time, source, confidence and data age. The same honesty rules as the CLI apply:
unknown shows as unknown, stale windows are labelled by age exactly as the CLI
labels them. One behaviour, two surfaces.

Make the panel readable in both light and dark VS Code themes. Colours come from
--vscode-* theme variables; the brand palette stays on borders, frames and
buttons only, which is the established design for this panel. After your change,
no hardcoded hex background may survive where a theme variable belongs.

Write the three tests listed in docs/08. Append your SPRINT-LOG.md entry. Commit:
feat(extension): add capacity cards and support light themes
```

## S5-T3 — Drop the Jan local worker and sync every status line

```text
Task S5-T3. Read docs/08-completion-plan.md section "S5-T3".

Jan is being dropped from the target design. Remove it from docs/04-adapters.md
and docs/05-quota-and-routing.md, replaced by ONE SENTENCE saying it was dropped
and why. Do not delete it without trace — a future reader must see it was a
decision, not an oversight.

Then make every status claim in docs/ true as of this branch. Every checklist box
in docs/05 sections 4A through 4D, every "still open" in docs/06, the known
limitations in docs/07 after S5-T1, and the index in docs/README.md which must
list 08, 09 and 10.

Tick a box only if the criteria in docs/08 were actually met. A stale checked box
is actively misleading, and this is the task where that gets fixed, not created.
If any task in this sprint was blocked, the docs must say so.

This is a documentation task; no tests. Append your SPRINT-LOG.md entry. Commit:
docs: drop the Jan local worker and sync every status line
```

## S5-T4 — Prepare the v1.0.0 release

```text
Task S5-T4. Read docs/08-completion-plan.md section "S5-T4".

Set the version to 1.0.0 consistently across the CLI, the daemon and the
extension. Review packages/protocol/src/version.ts: bump the protocol version
ONLY if the wire format actually changed incompatibly during these sprints, and
confirm the compatibility message still names which side is outdated.

Write CHANGELOG.md covering alpha to 1.0, grouped by what a user would notice,
including the limitations that remain.

Run all three gates and paste their output into SPRINT-LOG.md:
  corepack pnpm release:check
  corepack pnpm e2e:fresh
  corepack pnpm posix:verify

Absolutely no publishing: no npm publish, no vsce publish, no pushed git tag. A
local .tgz and .vsix are the deliverable. Releasing is the user's decision.

Commit:
build: prepare the v1.0.0 release artifacts
```

---

## FIX — when a sprint gate fails

```text
`corepack pnpm release:check` is failing on branch sprint/opencode-completion.

Diagnose and fix the actual cause. Rules from docs/10 apply, and two of them
matter especially here:

- Do not delete, skip or loosen a test to make it pass. If a test is genuinely
  wrong, say so in SPRINT-LOG.md with the reasoning, then fix it deliberately.
- Do not catch and swallow an error to make a failure disappear.

If the failure comes from a task you completed earlier, fix it in a new commit
rather than rewriting history. Record in SPRINT-LOG.md what broke, which task
introduced it, and why the earlier gate did not catch it — that last part is the
useful one.

Commit with a fix(scope): subject describing what was actually wrong.
```

## BLOCKED — when a task cannot be completed as specified

```text
Record the blocker in SPRINT-LOG.md following docs/10 section 7: what you were
asked to do, what you found instead, what you tried, and what would unblock it.

Do not weaken the success criteria so the task can be called done, and do not
commit a partial implementation as if it were complete. A task marked blocked
with a clear reason is a good outcome.

Then move to the next task in OPENCODE-PROMPTS.md.
```
