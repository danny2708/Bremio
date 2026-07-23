# 08 — Completion plan (alpha → v1.0)

The remaining distance between the shipped `v0.1.0-alpha.1` and the design in
`docs/00`–`docs/06`, broken into 5 sprints and 20 tasks.

**Execution status (2026-07-23):** Sprints 1–4 (with sprint 1's remediation) and
S5-T1/S5-T2 are merged into `main`, each audited before merge. Remaining:
**S5-T3** (this status sync) and **S5-T4** (v1.0 release prep), the latter
deliberately not started — see the note below. The Job Object guarantee in
S5-T1 is still not claimed: the Windows kill-walk race stands, but a run whose
workspace is still referenced now reports `cancellation_failed` with the pids
rather than a false `cancelled`. Current Windows gates pass `release:check`
(415 tests) and `e2e:fresh` (21 checks); `posix:verify` remains
**now passing** (2026-07-23). It had been recorded as environment-blocked "because
no WSL distribution is installed"; that was wrong twice over. WSL was installed
all along (Ubuntu 24.04, bash 5.2) — what was missing was Node inside the distro,
which `posix-verify.sh` checks for and exits on. With Node 22.23.1 installed
there via nvm, the gate runs and passes: 23 supervisor, 19 lifecycle, 18 storage,
14 protocol, 11 cancellation tests plus the `0600` token-file check. All three
v1.0 gates are green.

**On S5-T4 and the version number.** Dogfooding after Sprint 4 surfaced a gap
this plan never covered: runs are not stored or reopenable as sessions, the
process is not shown richly while working, and parallel tasks have no
overview. That work (session history and observability, then a stateful
context/harness layer) is scoped outside this document. Cutting `1.0.0` before
it lands would put a stability promise on the exact thing the first real user
found missing, so the version bump waits.

Every task states its **goal**, **why it exists**, the **files** it touches, its
**success criteria** as verifiable assertions, the **tests** it must produce,
and its **commit subject**. Criteria are written to be checkable by someone who
was not in the room — "make it work" is not a criterion.

Implementation is delegated. The rules — branch, untouchables, definition of
done, commit format, the honesty rule — live in
[`10-delegation-contract.md`](10-delegation-contract.md) and are not repeated
per task. The ready-to-paste prompts live in
[`../OPENCODE-PROMPTS.md`](../OPENCODE-PROMPTS.md).

## What is left, and where it goes

| Gap | Source | Task |
|---|---|---|
| OpenCode provider | `04` §OpenCode, `06` Phase 6 | S1-T1…T4 |
| Tiered model policy in config | `05` §Router scoring | S2-T1 |
| Antigravity model-id mapping | `05` 4C, last unchecked box | S2-T2 |
| Weighted scoring router | `05` §Router scoring | S2-T3 |
| Capacity refresh / native usage / unavailable | `05` 4A boxes 8–9 | S2-T4 |
| `net_gain` computation | `05` §Efficiency model | S3-T1 |
| Orchestration kill-switch | `05` §Guardrail, 4D last box | S3-T2 |
| Paired-evidence collection | `05` §Calibration gate | S3-T3, S3-T4 |
| Auto mode | `06` §Execution modes | S4-T1 |
| Single→Team escalation | `06` §Execution modes | S4-T2 |
| Windows process-tree guarantee | `07` §Known limitations | S5-T1 |
| Capacity cards + light theme | `05` 4A, `06` Phase 5 | S5-T2 |
| Jan local worker | `04`, `05` | **dropped** — S5-T3 |

**Deliberately not in scope**, so they are not orphans:

- **AQT's Claude window whitelist** (`05` 4A last box) — that change belongs to
  AI-Quota-Tray, which is a different repository and off-limits here.
- **npm registry / marketplace publication** — an outward-facing, irreversible
  release action. S5-T4 prepares the artifacts; a human publishes them.
- **Extracting Single into its own package** (`06` §Execution modes) — `06`
  already says to keep it in the orchestrator until a concrete boundary is
  justified. Nothing since has justified one.

---

# Sprint 1 — OpenCode as a first-class provider

Adds a fourth provider with a fourth integration shape. If `AgentAdapter` is
genuinely provider-agnostic, this sprint touches core in exactly one way:
registering one more adapter.

## S1-T1 — Verify the OpenCode automation surface

**Goal.** Replace every hypothesis in `docs/09-opencode-adapter.md` with an
observed fact.

**Why.** `docs/04` carries a standing "⚠️ Verify first" because these surfaces
change fast. It has already paid for itself: Antigravity turned out to ignore
the process cwd entirely, which would have silently corrupted every worktree run
had the adapter been written from assumptions.

**This is not a coding task.** No source changes. Probe, record, commit the doc.

**Files.** `docs/09-opencode-adapter.md` only.

**Success criteria.**
- Every `❓`/`❗` question in `docs/09` has a verdict in the Findings table, with
  the exact command run and what was observed.
- The workspace-targeting check is done in a **scratch git repo from a different
  cwd**, and the answer states definitively whether process cwd controls where
  files are written.
- The structured-output question ends in an explicit lead-eligible **yes or
  no**, with evidence. Guessing here mis-assigns planning work.
- Anything undeterminable is recorded as "not available" — never as an
  assumption dressed as a finding.
- The capability declaration block is filled in, each boolean traceable to a
  finding.

**Tests.** None (no source change). The `SPRINT-LOG.md` entry is the deliverable
alongside the doc.

**Commit.** `docs(opencode): record the verified automation surface`

## S1-T2 — Implement `packages/adapter-opencode`

**Goal.** An `AgentAdapter` implementation for OpenCode, built on S1-T1's
findings.

**Why.** One package per provider is the extension model in `docs/04`; core must
not learn a new provider name.

**Files.** New package mirroring `packages/adapter-antigravity/`'s scaffolding
(`package.json` with `@bremio/adapter-sdk` + `@bremio/protocol` as
`workspace:*`, `tsconfig.json` extending `../../tsconfig.base.json`, `src/`,
`test-fixtures/`). Inside: `src/index.ts`, `src/opencode-adapter.ts`, a surface
module named for what S1-T1 chose (`http-client.ts` or `cli.ts`),
`src/opencode-adapter.test.ts`. Add the package to the workspace.

**Success criteria.**
- Implements all seven `AgentAdapter` members
  (`packages/adapter-sdk/src/adapter.ts`). `resumeRun` may reject as
  unsupported — explicitly, not by returning an empty stream.
- `getCapabilities()` returns the declaration from S1-T1. **No boolean is `true`
  without a finding behind it.**
- `healthCheck()` distinguishes at least: binary missing → `unavailable`;
  present but unauthenticated → `degraded`; ready → `ok`. If the surface offers
  no reliable auth check, the heuristic is documented in a comment, as
  `adapter-antigravity` does.
- `startRun()` yields normalized `AgentEvent`s and ends with **exactly one**
  terminal `completed` event, on both the success and failure paths.
- `cancelRun(runId)` is idempotent and safe before start and after completion.
- Binary resolution: `BREMIO_OPENCODE_BIN` first, then PATH. On Windows, handle
  the npm `.cmd` shim — reuse the approach in
  `apps/vscode-extension/src/cli-launcher.ts`, do not re-derive it.
- Errors map onto the existing classification in
  `packages/adapter-sdk/src/errors.ts` rather than a new scheme.

**Tests** (`src/opencode-adapter.test.ts`, over recorded fixtures in
`test-fixtures/`):
1. a recorded successful run normalizes to the expected `AgentEvent` sequence;
2. exactly one terminal event is emitted, and nothing follows it;
3. a recorded failure still terminates rather than hanging;
4. `cancelRun` before `startRun` is a no-op;
5. `healthCheck` returns `unavailable` when the binary cannot be resolved.

**Commit.** `feat(adapter-opencode): add the OpenCode provider adapter`

## S1-T3 — Offer OpenCode everywhere an agent is chosen

**Goal.** OpenCode is selectable in every surface that lists agents.

**Why.** An adapter nobody can select is dead code. There are currently six
places that enumerate the three agents; a fourth provider is the test of whether
that enumeration is maintainable.

**Files.**
- `apps/cli/src/index.ts` — help text (~lines 48, 63, 65), the `agentIds` set
  (~line 206), worker validation (~line 220)
- `apps/daemon/src/server.ts` — the adapter list (~line 164)
- `apps/cli/src/tui/data.ts` — the display-name map (~line 19) and adapter list
  (~line 24)
- `apps/vscode-extension/src/webview.ts` — the agent picker
- `scripts/provider-smoke.ts` — agent id union and argument parsing

**Success criteria.**
- `bremio run --mode single --agent opencode` is accepted and reaches the
  adapter; an unknown id is still rejected with a message listing the valid ones.
- `--worker opencode` is accepted for Team runs.
- `bremio doctor` lists four adapters, and OpenCode reports lead-eligibility
  consistent with its capabilities.
- The TUI agent picker and the VS Code panel both offer OpenCode.
- `grep -rn '"claude", "codex", "antigravity"'` over `apps/` and `packages/`
  returns nothing — no hardcoded three-agent triple survives.
- If S1-T1 found OpenCode **not** lead-eligible, `--lead opencode` is rejected
  by the existing capability contract, **not** by a name check.

**Tests.**
1. CLI argument validation accepts `opencode` for `--agent` and `--worker`, and
   rejects a bogus id;
2. the daemon's registry contains four adapters;
3. lead selection respects the capability contract for the new adapter.

**Commit.** `feat(opencode): offer OpenCode everywhere an agent is chosen`

## S1-T4 — Prove OpenCode with a real run

**Goal.** Evidence from a real billed run, not fixtures.

**Why.** Every other adapter in this project was accepted only after a real
provider run. Fixtures prove parsing; they do not prove the provider does what
the adapter believes.

**Files.** `docs/04-adapters.md` (replace the OpenCode stub with a full,
verified section in the same shape as the Antigravity one), `docs/06-roadmap.md`
(Phase 6 status), `docs/09-opencode-adapter.md` (mark verified).

**Success criteria.**
- `corepack pnpm smoke:providers --agent opencode` completes a real Single run
  that **creates a file in the target repo**, and produces a report plus a
  ledger entry.
- If S1-T1 found OpenCode lead-eligible: one Team run with `--lead opencode`
  produces a `PlanSchema`-valid plan, delegates ≥1 task to a different agent,
  and passes the quality gate. If not lead-eligible: one Team run with
  `--worker opencode` completes an implementation task instead.
- `bremio doctor` reports OpenCode `ok`.
- `docs/04`'s OpenCode section states the verified surface, auth model,
  workspace targeting, permission mapping, streaming shape, roles and binary
  resolution — the same questions answered for every other provider.
- The run id and observed output are pasted into `SPRINT-LOG.md`.

**Tests.** No new unit tests; the artifacts are the evidence.

**Commit.** `docs(adapters): promote OpenCode from future to verified`

---

# Sprint 1R — Remediation (added 2026-07-21 after review)

Sprint 1 shipped working code and found a genuinely hard bug (the Windows
stdin-pipe hang). Review found three defects it could not have caught, fixed in
`fix(adapter-opencode): stop damaging prompts, cancels and model ids`, plus
three that needed real work (S1-R1 through S1-R3). Their execution surfaced a
fourth: S1-R3 quietly changed the `structuredOutput` mechanism without moving
the boolean, which S1-R4 resolves by deciding OpenCode is a worker, not a lead
candidate. All four are here.

## S1-R1 — Replace the hand-written provider fake with recorded reality

**Goal.** Tests that fail when OpenCode's actual response shape changes.

**Why.** `test-fixtures/fake-opencode.mjs` is hand-written, so it asserts the
adapter's own assumptions. The whole suite stayed green through three rounds of
live debugging in which the adapter could not parse a single real response —
first `data.info.structured_output`, then `info.text`, and only then the real
`parts[].text`. A fixture that cannot be wrong cannot catch a bug.

**Files.** `packages/adapter-opencode/test-fixtures/`,
`packages/adapter-opencode/src/opencode-adapter.test.ts`, and a small recording
script if that helps.

**Success criteria.**
- Real captured output is committed as fixture data: one `--format json` CLI
  stream, and one `POST /session/:id/message` response body from a live
  `opencode serve`. Redact anything user-specific; keep the shape byte-exact.
- The event mapper and the server-response parser are tested **against those
  recorded bytes**, not against the fake.
- The **server/lead path has tests at all** — today it has none, which is why
  the path that broke three times was the one nothing covered.
- The existing fake may stay for spawn mechanics, exit codes and cancellation.
  It must no longer be the only source of truth about a response shape.
- Verify each new test can fail: change the parser to read the wrong field and
  confirm it goes red. Note this in `SPRINT-LOG.md`.

**Commit.** `test(adapter-opencode): parse recorded provider output, not a guess`

## S1-R2 — Make the structured-output claim true or drop it

**Goal.** `structuredOutput` describes a guarantee the adapter actually provides.

**Why.** The adapter declares `structuredOutput: true` and `planning: true`,
which makes OpenCode lead-eligible. But S1-T4 **removed** the `format:
json_schema` request after the default provider rejected it, so nothing
constrains the output any more — the lead returns valid plan JSON because a
particular free model happened to comply when asked in prose. That is an
observation about one model, not a property of the adapter, and `docs/10` §6c
says the boolean moves with its mechanism.

**Files.** `packages/adapter-opencode/src/opencode-adapter.ts`, its tests,
`docs/04-adapters.md`, `docs/09-opencode-adapter.md`.

**Success criteria.** Pick **one** and say in `SPRINT-LOG.md` which and why:

- **(a) Earn the claim.** The adapter validates the final output against
  `req.outputSchema` and fails the run when it does not match, so a caller that
  gets a completed run is guaranteed schema-valid output. If the
  `@opencode-ai/sdk` structured-output path works where the raw HTTP `format`
  field did not, use it. `structuredOutput` stays `true`, and a test proves a
  non-conforming response produces a **failed** outcome, not a completed one.
- **(b) Drop the claim.** `structuredOutput: false`, OpenCode becomes a worker
  like Antigravity, and the capability contract excludes it from lead with no
  name check anywhere. `docs/04` and `docs/09` say so plainly.

Either way: `vision: true` currently has no probe behind it — verify it or set
it `false`. And `docs/09`'s "Eligible to be the lead" must match the outcome.

**Commit.** `fix(adapter-opencode): make the structured-output claim honest`

## S1-R3 — Settle the shared review-prompt change

**Goal.** Decide whether the `buildTaskPrompt` change stays, on evidence.

**Why.** S1-T4 was a docs-only task. It edited
`packages/orchestrator/src/plan-schema.ts`, changing the **review prompt for
every provider** so that OpenCode's model would emit parseable findings. It may
well be an improvement — the old text referenced an "output schema" it never
showed. But it was untested, unrecorded, and it silently changed Claude's and
Codex's review behaviour to fix a third provider's problem.

**Files.** `packages/orchestrator/src/plan-schema.ts` and its test.

**Success criteria.**
- A test asserts the review prompt states the required JSON shape, so the
  contract between `buildTaskPrompt` and `parseReviewOutput` in
  `quality-gate.ts` is pinned rather than incidental.
- The change is verified against **Claude and Codex** reviews, not only
  OpenCode — one real Team run each, gate passing, evidence in `SPRINT-LOG.md`.
- If either regresses, make the extra instruction provider-conditional or revert
  it. Do not leave a cross-provider change resting on one provider's evidence.

**Commit.** `test(orchestrator): pin the review prompt to the parser's contract`

## S1-R4 — Make OpenCode worker-only, for real, everywhere

**Goal.** `structuredOutput: false` for OpenCode, and every surface that
currently accepts `--lead opencode` rejects it through the capability
contract — not because its name was removed from a list, because it never
belonged on that list next to a name check in the first place.

**Why.** S1-R2 offered two honest options — earn the `structuredOutput: true`
claim, or drop it — and S1-R3 landed a third, undocumented one: it removed the
`format: json_schema` attempt entirely and simplified validation to "is this
parseable JSON," while leaving the boolean at `true`. Decision (2026-07-22):
drop it. OpenCode's mechanism has no schema enforcement and no repair loop the
way `lead-manager.ts` gives Claude/Codex two attempts at a plan; S1-R3 also
found the default provider returns **200 OK with an empty response** instead of
an error when it rejects a schema constraint, which is a bad property to build
lead trust on regardless of how the fallback is wired. Claude and Codex already
cover the lead role with a schema constraint their own provider enforces.
OpenCode stays a fully capable **worker** — this changes nothing about
implementer, test, or review task assignment.

Separately, `apps/cli/src/index.ts`'s `--lead` validation
(`errors.push("Team mode requires --lead 'claude', 'codex', or 'opencode'")`)
and `scripts/provider-smoke.ts`'s `LeadId` type both hardcode `opencode` into
a lead-name list. This is exactly what S1-T3 committed to not doing
("`--lead opencode` is rejected by the existing capability contract, **not**
by a name check") — the commit that added OpenCode broadly merged "known
agent id" with "lead-eligible agent id" into one set. Fix the mechanism, not
just the boolean, or the next capability-only provider hits the same bug.

**Files.**
- `packages/adapter-opencode/src/opencode-adapter.ts` — flip
  `structuredOutput` to `false`; comment states the mechanism gap, not just
  the value.
- `packages/adapter-opencode/src/opencode-adapter.test.ts` — capabilities test
  now expects `structuredOutput === false`.
- `apps/cli/src/opencode-registration.test.ts` — rename/update the
  "lead-eligible capabilities" test to assert the opposite.
- `apps/cli/src/index.ts` — the `--lead` id check stays a coarse "is this a
  known agent" guard using the general `agentIds` set (typo protection,
  message no longer enumerates providers by name); add a **separate**
  capability-driven check after `registry` is built (`registry.get(leadId)!
  .getCapabilities()`, requiring `planning && structuredOutput`) that produces
  a clear error naming which capability is missing. `--worker opencode` is
  untouched — workers aren't capability-gated at the CLI layer.
- `scripts/provider-smoke.ts` — narrow `type LeadId` to `"claude" | "codex"`;
  update `--lead` parsing and its error message; `AgentId`/`--agent`/`--worker`
  parsing keep accepting `opencode`.
- `docs/04-adapters.md`, `docs/06-roadmap.md`, `docs/09-opencode-adapter.md` —
  already corrected directly (2026-07-22, this task's doc half). Confirm the
  code matches what they now say; do not re-word them.

**Success criteria.**
- `caps.structuredOutput` is `false` for OpenCode; `caps.planning` stays `true`.
- `bremio run --mode team --lead opencode ...` is rejected with a message that
  names the missing capability, not "unknown agent."
- `bremio run --mode team --worker opencode ...` still works.
- `pnpm smoke:providers --lead opencode` fails to parse its arguments (typed
  out of `LeadId`) rather than attempting a run.
- `grep -rn '"claude", "codex", "opencode"' apps/ scripts/` finds no
  lead-context match (worker/agent-listing matches are fine).
- `corepack pnpm doctor` (or the CLI's doctor output) shows OpenCode
  `lead-eligible: no`.

**Tests.**
1. Capability test asserts `structuredOutput: false`.
2. CLI test: `--mode team --lead opencode` produces the capability error, not
   a silent pass-through.
3. CLI test: `--mode team --worker opencode --lead codex` still validates.
4. `provider-smoke.ts` type-level: confirm (via a quick manual invocation, not
   a new unit test) that `--lead opencode` throws before any process spawns.

**Commit.** `fix(opencode): stop treating opencode as lead-eligible`

---

# Sprint 2 — Routing completion

Closes `docs/05` §4A residue and §4C. The router today is the Phase-1
deterministic one plus an opt-in safety slice; the design calls for weighted
scoring driven by configuration.

## S2-T1 — Move the tiered model policy into `config/routing.yaml`

**Goal.** Policy — thresholds, tiers, model choices — lives in a validated
config file, not in code.

**Why.** `docs/05` is explicit: *"model names are NEVER hardcoded in core — each
adapter maps `reasoningRequirement` → its own provider's model."* No `config/`
directory exists yet, so this is the missing foundation for S2-T3 and S3-T2.

**Files.** New `config/routing.yaml`; new
`packages/orchestrator/src/routing-config.ts` and `routing-config.test.ts`; wire
into `packages/orchestrator/src/router.ts`.

**Success criteria.**
- A Zod schema validates the file, covering the `capacityPolicy` and `routing`
  blocks exactly as `docs/05` §Router scoring specifies (`healthy` 50%,
  `limited` 20%, `critical` 5%, `reserveLeadCapacityPercent` 15,
  `unknownQuotaPenalty` 10) plus the scoring weights and the tier table.
- Tiers map a `reasoningRequirement` (trivial → critical) to a **per-adapter**
  model id, so a tier never names one provider's model globally.
- An invalid file **fails loudly**, naming the offending path — it never
  silently falls back to defaults. A wrong policy that looks applied is worse
  than a missing one.
- An **absent** file yields the documented defaults, and says so once.
- `grep` over `packages/orchestrator/src/*.ts` finds no provider model id string
  literal.
- Existing behaviour is unchanged when the file is absent — no existing test
  needs editing to pass.

**Tests.**
1. a valid file parses into the expected policy object;
2. an invalid tier is rejected, and the error message contains the config path;
3. a missing file produces the documented defaults;
4. an assertion that core contains no hardcoded model literals.

**Commit.** `feat(routing): move the tiered model policy into config/routing.yaml`

## S2-T2 — Map Antigravity buckets to verified model ids

**Goal.** Populate `modelId` on Antigravity capacity windows so the router can
be model-aware.

**Why.** The last unchecked box in `docs/05` §4C. AQT persists a
*display-derived* bucket key, not a provider model id, so Bremio currently marks
those windows model-scoped with no `modelId` and refuses to route on them.

**Files.** `packages/quota/src/aqt-provider.ts` and its test; the mapping table
(in `config/routing.yaml` from S2-T1, or a dedicated module — state which and
why in `SPRINT-LOG.md`).

**Success criteria.**
- Known AQT display keys map to verified provider model ids through an
  **explicit table**, never a string transform or a guess.
- An **unknown** key leaves `modelId` absent and that window stays ineligible
  for routing — fail closed. A new bucket appearing upstream must not silently
  become a routing input.
- The router selects the window for the *candidate* model: one limited
  Antigravity model must not make every other Antigravity model unavailable
  (`docs/05` §Router rules).
- The mapping's source of truth is named in `docs/05`, and the 4C box is ticked
  only if the criteria above hold.
- Retired buckets stay dropped — this must not resurrect them.

**Tests.**
1. a known key resolves to its model id;
2. an unknown key stays unmapped and is not routed on;
3. a limited model window does not exclude a different Antigravity model;
4. a `retired` bucket is still ignored.

**Commit.** `feat(quota): map Antigravity buckets to verified model ids`

## S2-T3 — Score agents instead of assigning them positionally

**Goal.** Implement the weighted router from `docs/05` §Router scoring.

**Why.** Today's router is positional: analysis → lead, everything else →
worker, plus a delegation guarantee. That was the right Phase-1 call and it
cannot express "this task needs a large context window and the worker is at 4%".

**Files.** `packages/orchestrator/src/router.ts`,
`packages/orchestrator/src/router.test.ts`.

**Success criteria.**
- Score is computed as specified:
  `capability*0.30 + quota*0.25 + taskFit*0.20 + quality*0.15 + speed*0.05 + preference*0.05`,
  with the weights read from `config/routing.yaml` (S2-T1), not inlined.
- Hard rules hold exactly: self-review penalty `-100` when the candidate is the
  task's author and `kind === "review"`; `-40` when quota status is `critical`;
  `-Infinity` when the task needs write and the agent lacks
  `repositoryWrite`.
- **Only** fresh, high-confidence exhaustion may hard-exclude a candidate.
  Stale, unknown or low-confidence quota applies `unknownQuotaPenalty` and can
  **never** be the sole reason an agent is excluded. This is load-bearing: it is
  the property that stops a dead AQT from stopping all work.
- `reserveLeadCapacityPercent` is honoured before extra worker tasks land on the
  lead.
- The delegation guarantee survives: at least one task still reaches a different
  agent.
- Scoring is **opt-in** for now — the existing deterministic path stays the
  default until enabled through config or `--capacity-routing`, and every
  existing router test passes unchanged.

**Tests.** One test per hard rule above, plus:
- stale quota alone never excludes an agent;
- an agent without `repositoryWrite` never receives a write task;
- the lead reserve is respected;
- with scoring disabled, behaviour is byte-identical to today.

**Commit.** `feat(router): score agents instead of assigning them positionally`

## S2-T4 — Finish the capacity observe-and-display surface

**Goal.** Close the two remaining 4A boxes: manual refresh, native-usage links,
explicit unavailable states.

**Why.** `docs/05` §Capacity surface specifies these, and the honesty principle
depends on them — an unavailable provider must *look* unavailable, not blank.

**Files.** `apps/cli/src/quota.ts`, `apps/cli/src/tui/` (capacity screen),
`packages/quota/src/capacity.ts` (`openNativeUsage`).

**Success criteria.**
- An unavailable or unknown provider renders an explicit state with the reason —
  never a blank row and never a fabricated percentage.
- A manual refresh action exists in both the CLI and the TUI, and states whether
  the result was LIVE or last-known (the existing `bremio capacity` convention).
- `openNativeUsage` opens the provider's own usage page where one exists, and is
  **absent** — not present-and-broken — where none does.
- Data age, source, confidence and freshness stay visible on every window; this
  task must not regress the existing stale-labelling work.

**Tests.**
1. an unavailable snapshot renders the unavailable state, not an empty one;
2. `openNativeUsage` is undefined for a provider with no native page;
3. a refresh that fails still renders last-known values, labelled as such.

**Commit.** `feat(capacity): finish the observe-and-display surface`

---

# Sprint 3 — Efficiency: measure the net, then act on it

`docs/05` §Efficiency model is the project's central claim: multi-agent must
*earn its keep*. The ledger exists; the arithmetic on top of it does not.

## S3-T1 — Compute net gain against the single-agent baseline

**Goal.** Turn ledger entries into `net_gain`.

**Why.** `docs/05` P3: *"Measure net, not gross."* The invariant to enforce is
`net_gain > 0`, and today nothing computes it.

**Files.** New `packages/orchestrator/src/net-gain.ts` and `net-gain.test.ts`;
read from `packages/orchestrator/src/ledger.ts`.

**Success criteria.**
- `net_gain = quota_saved_vs_baseline − orchestration_cost`, where orchestration
  cost includes lead planning, aggregation, handoff and escalation retries —
  the `scope: "coordination"` entries already recorded.
- The baseline is **the best single-agent run for the same `comparisonId`**, per
  `docs/05`. Not an average, not an estimate.
- **Any missing input yields an explicit `unknown`.** No price is ever imputed,
  no token count is converted into subscription quota, no partial result is
  reported as a number. This is the difference between measurement and
  storytelling.
- The result carries *why* it is unknown when it is, so `bremio stats` can name
  the specific blocker.

**Tests.**
1. complete provider-reported data on both sides computes the expected value;
2. one missing cost anywhere yields `unknown` with a reason;
3. a comparison group with no Single baseline yields `unknown`;
4. multiple Single runs in a group use the best one as the baseline.

**Commit.** `feat(ledger): compute net gain against the single-agent baseline`

## S3-T2 — Fall back to single-agent when coordination costs too much

**Goal.** The kill-switch from `docs/05` §Guardrail — the last unchecked 4D box.

**Why.** Without it, a run whose orchestration overhead exceeds its task cost
still completes as a Team run, going net-negative with nothing to stop it.

**Files.** `packages/orchestrator/src/run.ts`, threshold in
`config/routing.yaml`, tests alongside.

**Success criteria.**
- When measured orchestration overhead exceeds the configured share of task
  cost, the run falls back to single-agent and **records the reason** in the
  report.
- The threshold is configurable and has a documented default.
- The switch is **inert when cost data is incomplete**. It fires on
  provider-reported numbers or not at all — a kill-switch triggering on an
  estimate would abort good runs for imaginary reasons.
- The fallback is surfaced to the user, never silent.
- A run already past the point where fallback is meaningful is not restarted;
  state clearly at which point the decision is made.

**Tests.**
1. overhead above threshold triggers fallback and the report records why;
2. incomplete cost data never triggers it;
3. overhead below threshold leaves the Team flow untouched;
4. the reason string reaches the run report.

**Commit.** `feat(orchestrator): fall back to single-agent when coordination costs too much`

## S3-T3 — Report net gain and name every calibration blocker

**Goal.** Surface S3-T1 and the calibration gate in `bremio stats`.

**Why.** The gate already computes readiness
(`packages/orchestrator/src/calibration.ts`); it cannot yet show whether the
multi-agent flow is actually paying for itself.

**Files.** `apps/cli/src/stats.ts` and its test;
`packages/orchestrator/src/calibration.ts` if the readiness shape needs net gain.

**Success criteria.**
- `bremio stats` reports net gain per comparison group and in aggregate.
- `unknown` displays as `unknown` with its reason — never as `0`, never hidden.
- Each calibration blocker names the **specific** missing dimension and how many
  more samples are needed, not a generic "insufficient evidence".
- The `single-agent` recommendation remains the fail-closed default until every
  threshold passes.

**Tests.**
1. a mix of known and unknown groups renders both correctly;
2. blockers name the specific dimension;
3. the recommendation stays `single-agent` while any threshold fails.

**Commit.** `feat(stats): report net gain and name every calibration blocker`

## S3-T4 — Collect paired evidence in one command

**Goal.** `bremio compare --repo <path> "<prompt>"` runs both flows as a
controlled pair.

**Why.** The calibration gate needs ≥5 paired comparisons. Today that means
running `--comparison <id>` twice by hand against an identical starting tree —
tedious, and easy to invalidate by letting the tree drift between runs.

**Files.** `apps/cli/src/index.ts` (command + help), a new compare module and
test, reusing `runSingleAgent` and `runBremio` from
`packages/orchestrator/src/index.ts`.

**Success criteria.**
- One command runs the Single baseline and the Team flow with a **shared
  generated `comparisonId`**, both starting from the same tree state.
- It **refuses on a dirty working tree** — a controlled comparison over a
  drifting tree is not evidence.
- Both run-scope ledger entries are recorded with the correct `flowMode` and
  objective outcome.
- The pair is printed side by side, including net gain when computable.
- Each side is independently cancellable; cancelling one does not corrupt the
  other's ledger entry.

**Tests.**
1. both entries share the generated `comparisonId`;
2. a dirty tree is refused before either run starts;
3. cancelling the first side leaves a coherent, incomplete-but-honest record.

**Commit.** `feat(cli): collect paired single-vs-team evidence in one command`

---

# Sprint 4 — Auto mode and escalation

The last deferred items in `docs/06` §Execution modes. Both are gated on
Sprint 3's evidence machinery: an uncalibrated automatic router can make
`net_gain` negative (`docs/05` §escalation double-pay trap).

## S4-T1 — Calibration-gated automatic mode selection

**Goal.** `bremio run --mode auto` chooses Single or Team.

**Why.** `docs/00` P2 and `docs/06` both hold Auto until manual modes have
evidence. That evidence path now exists, so Auto can be built — gated.

**Files.** `apps/cli/src/index.ts`, a mode-selection module in
`packages/orchestrator/src/`, tests alongside.

**Success criteria.**
- While calibration readiness is `insufficient-evidence`, `--mode auto`
  **always** chooses Single. No task shape, size or keyword overrides this. This
  is the fail-closed property the whole design rests on.
- Once readiness is `ready`, selection uses task shape plus capacity, and the
  policy is configurable — not a hardcoded heuristic.
- The chosen mode **and the reason** are recorded in the report and printed
  before execution.
- An explicit `--mode single` or `--mode team` always wins over auto.
- Auto is opt-in; the default mode is unchanged.

**Tests.**
1. insufficient evidence → Single, across several task shapes;
2. ready + a task shape meeting the policy → Team;
3. an explicit mode always beats auto;
4. the reason reaches the report.

**Commit.** `feat(cli): add calibration-gated automatic mode selection`

## S4-T2 — User-approved escalation from Single to Team

**Goal.** A failed Single run may be escalated to Team — only with explicit
approval.

**Why.** `docs/05` R5: cheap-first that guesses wrong pays twice. Escalation is
only honest when the user consents and the double cost is recorded.

**Files.** `packages/orchestrator/src/single-run.ts` and `run.ts`,
`apps/cli/src/index.ts`, tests alongside.

**Success criteria.**
- Escalation is offered only after a Single run **fails its verification**, not
  on any failure signal the model reports about itself.
- It **never** runs without explicit approval: `--escalate` up front, or an
  interactive confirmation. Silence is not consent.
- The escalated Team run reuses the original prompt and joins the same
  comparison group, so the ledger shows the **combined** cost of both attempts —
  that is the whole point of measuring double-pay.
- Declining leaves the Single result and its artifacts intact.
- Non-interactive contexts (no TTY) without `--escalate` do not escalate, and
  say why.

**Tests.**
1. no approval → no escalation;
2. approval → a Team run linked to the original;
3. both attempts' costs are recorded in one group;
4. a passing Single run is never offered escalation.

**Commit.** `feat(orchestrator): offer user-approved escalation from single to team`

## S4-T3 — Say why every automatic choice was made

**Goal.** Every automatic decision carries a human-readable reason that reaches
all three surfaces.

**Why.** Sprints 2–4 add four kinds of automatic decision — flow selection,
agent scoring, capacity exclusion, kill-switch fallback. A system that silently
routes work is one the user cannot trust or debug, and the project's stated
value is honesty.

**Files.** `packages/protocol/src/` (reason on the relevant events/results),
`apps/daemon/src/server.ts`, `apps/cli/src/ui.ts`, `apps/cli/src/tui/`,
`apps/vscode-extension/src/webview.ts`.

**Success criteria.**
- Flow choice, agent choice, capacity exclusion and kill-switch fallback each
  carry a reason string stating the actual cause ("codex at 4% remaining, fresh"
  — not "policy").
- The reason survives the daemon protocol round-trip and appears in the CLI, the
  TUI and the VS Code panel.
- No surface displays an automatic choice without its reason.
- Reasons never contain secrets, prompts or repository content — the redaction
  rules in `apps/cli/src/diagnostics.ts` apply here too.

**Tests.**
1. a reason survives serialization through the daemon and back;
2. one rendering test per surface;
3. a reason containing a token-like string is redacted.

**Commit.** `feat(ui): say why every automatic choice was made`

## S4-T4 — Prove the fail-closed properties hold together

**Goal.** One integration test asserting the safety properties as a set.

**Why.** The fail-closed behaviour is now spread across the router, the
calibration gate, the kill-switch and escalation. Each has unit tests; nothing
proves they still hold *in combination*, which is exactly where safety
properties die.

**Files.** One new integration test file under
`packages/orchestrator/src/` (name it for what it proves, e.g.
`fail-closed.integration.test.ts`).

**Success criteria.** End to end, with the real router and real calibration
evaluation — not mocks of the things under test — the file asserts:
1. uncalibrated `--mode auto` never selects Team;
2. stale or unknown quota never hard-excludes an agent;
3. incomplete cost data never fires the kill-switch;
4. escalation never runs without approval;
5. an agent without `repositoryWrite` never receives a write task;
6. an unmapped Antigravity bucket is never routed on.

Each assertion fails for the right reason if the corresponding guard is removed
— verify that by removing one temporarily, then restoring it, and note it in
`SPRINT-LOG.md`.

**Commit.** `test: prove the fail-closed properties hold together`

---

# Sprint 5 — Hardening and v1.0

## S5-T1 — Guarantee the process tree dies with the run on Windows

**Goal.** Close the known limitation in `docs/07`.

**Why.** `taskkill /T /F` walks the tree it can see at that instant; a grandchild
spawned during the walk survives. The `ProcessSupervisor` contract is that
`cancelled` means *confirmed stopped* — a weaker termination undermines the
strongest correctness guarantee in the project.

**Files.** `packages/adapter-sdk/src/process-supervisor.ts` and its test;
`docs/07-operations.md` §Known limitations.

**Success criteria.**
- Either a Job Object gives the real guarantee (no grandchild can outlive the
  run), **or** — if that requires a native dependency this project declines —
  a documented alternative that closes the spawned-during-the-walk gap, with the
  residual risk stated plainly in `docs/07`.
- Verified against a **real three-level process tree on Windows**: parent →
  child → grandchild, all confirmed gone by pid after termination.
- POSIX behaviour (process groups, `kill(-pgid)`) is unchanged and its tests
  still pass.
- If a new dependency is introduced, `SPRINT-LOG.md` records what it is and why
  nothing already present would do.
- `docs/07` is updated to whatever is now true — including "still a limitation,
  narrowed to X" if that is the honest outcome.

**Tests.** A supervisor test spawning a real three-level tree and asserting
every pid is gone afterwards. Skip cleanly on non-Windows rather than asserting
something meaningless there.

**Commit.** `fix(supervisor): guarantee the process tree dies with the run on Windows`

## S5-T2 — Capacity cards and light-theme support in the panel

**Goal.** The last Phase-5 gap and the last 4A box.

**Why.** `docs/06` records the panel as dark-only; `docs/05` §Capacity surface
specifies graphical cards. VS Code users on a light theme currently get an
unreadable panel.

**Files.** `apps/vscode-extension/src/webview.ts` and its tests.

**Success criteria.**
- One capacity card per agent showing every window with its percentage, reset
  time, source, confidence and data age — the same honesty rules as the CLI, so
  unknown shows as unknown.
- The panel is readable in both light and dark VS Code themes. Colours come from
  `--vscode-*` theme variables; the brand palette stays on borders, frames and
  buttons only, matching the established design.
- No hardcoded hex background survives where a theme variable belongs
  (grep-checked).
- Stale windows are labelled in the panel exactly as the CLI labels them — one
  behaviour, two surfaces.

**Tests.**
1. a rendering test for a snapshot with mixed fresh/stale/unknown windows;
2. an assertion that no literal hex background remains in the generated markup;
3. an unavailable provider renders its explicit state.

**Commit.** `feat(extension): add capacity cards and support light themes`

## S5-T3 — Drop the Jan local worker and sync every status line

**Goal.** Remove Jan from the target design, and make every status claim in
`docs/` true as of this branch.

**Why.** Jan was in the vision as near-free local capacity. It is being dropped
deliberately, and a dropped item must be *recorded as dropped* — silently
deleting it would leave a future reader thinking it was forgotten. Separately,
five sprints of work have invalidated many status lines, and a stale checked box
is actively misleading.

**Files.** `docs/04-adapters.md`, `docs/05-quota-and-routing.md`,
`docs/06-roadmap.md`, `docs/07-operations.md`, `docs/00-overview.md`,
`docs/README.md`.

**Success criteria.**
- Jan is removed from `docs/04` and `docs/05`, replaced by **one sentence
  saying it was dropped and why** — not deleted without trace.
- Every checklist box in `docs/05` §4A–4D reflects the code on this branch. A
  box is ticked only if the criteria in this plan were actually met.
- Every "still open" in `docs/06` is either closed or restated accurately.
- `docs/07` §Known limitations matches reality after S5-T1.
- `docs/README.md` indexes 08, 09 and 10.
- No claim survives that this branch made false.

**Tests.** None (documentation).

**Commit.** `docs: drop the Jan local worker and sync every status line`

## S5-T4 — Prepare the v1.0.0 release

**Goal.** Release-ready artifacts. **Not** a release.

**Why.** Publication is outward-facing and irreversible; a delegated agent
prepares it and a human performs it (`docs/10` §2).

**Files.** version fields across `package.json`, `apps/daemon`,
`apps/vscode-extension`; `packages/protocol/src/version.ts` (review, change only
if the wire format actually changed); new `CHANGELOG.md`; `README.md` status.

**Success criteria.**
- Version set to `1.0.0` consistently across CLI, daemon and extension.
- The protocol version is **reviewed and justified**: bumped only if the wire
  format changed incompatibly, and the compatibility message still names which
  side is outdated.
- `CHANGELOG.md` covers alpha → 1.0, grouped by what a user would notice, with
  the known limitations that remain.
- All three gates pass, with their output pasted into `SPRINT-LOG.md`:
  `corepack pnpm release:check`, `corepack pnpm e2e:fresh`,
  `corepack pnpm posix:verify`.
- **No `npm publish`, no `vsce publish`, no pushed git tag.** Building a local
  `.tgz` and `.vsix` is the deliverable.

**Tests.** The three gates above.

**Commit.** `build: prepare the v1.0.0 release artifacts`

---

## After the sprints

The branch is reviewed commit by commit against the success criteria above, with
`SPRINT-LOG.md` cross-checked against the actual diff. The outcome is a
per-sprint quality judgement and a keep / fix / discard recommendation — the
branch exists so that discard is a real option.
