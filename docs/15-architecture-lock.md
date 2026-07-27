# 15 — Architecture lock: mediation, session identity, and daemon authority

**Status:** locked contract. Amends [`14-architecture-review-and-plan.md`](./14-architecture-review-and-plan.md).
**Locked at:** `main` @ `16d145a` (v1.2.0), schema v3, 544 tests green.
**Purpose:** define the concepts that must be settled before M0 begins, so
schema, protocol and the approval engine are not rewritten mid-flight.

This document decides *semantics*. It ships no feature. The only code that
landed alongside it is the two P0 containment patches described in §7.

---

## 1. Verified current state

Every claim below was checked against the working tree or the real database at
`~/.bremio/bremio.db`. Claims that could not be verified are labelled.

### 1.1 Resume always selects Claude — it does not merely risk it

`apps/cli/src/session.ts` derived the agent from a provider-reported model
string. That string comes from the last `usage` event (`storage.ts:549`).

The real database holds **897 events and zero of type `usage`**:

```
event types: task-event 790 · lead 48 · task-start 16 · task-complete 15
             finished 10 · status 8 · failed 5 · plan 4 · interrupted 1
```

So `model` was always `undefined`, the `split("/")` branch **never executed
once**, and `?? "claude"` was the only live path. Every resume ran Claude.

The consequence is recorded in the user's own history:

```
session 12c2b93f-e71f-41ee-96f1-bb7f715eaa3c
  turn 0: lead=antigravity  mode=single
  turn 1: lead=claude       mode=single
```

Collaboration mode was lost the same way: `session.ts` read `detail.mode`, but
`SessionDetail` (`storage.ts:564`) never projected `runs.mode`, so it was always
`undefined` and every Co-lab session resumed as Solo.

### 1.2 The data needed to fix it already exists

| Column | Coverage across all 16 runs |
|---|---|
| `runs.mode` | 16 / 16 |
| `runs.lead_provider` | 15 / 16 |
| `runs.worker_providers` | populated where applicable (`["antigravity"]`, `["claude"]`) |

No migration is required for the containment fix. A schema is still required for
M0 to persist *requested* configuration (model, reasoning, control mode, tools),
none of which is stored today.

### 1.3 Solo runs directly in the user's workspace

`single-run.ts:170,195` pass `cwd: repoPath`. Only Co-lab uses
`packages/workspace` worktrees. This is why workspace strategy must become an
independent axis (§2.3) rather than an implied property of collaboration mode.

### 1.4 Antigravity: the bypass was deliberate, and a better path exists

`agy` **1.1.5**, `--help` captured via redirection (it writes nothing to a
non-TTY stdout through PowerShell's pipeline — itself a finding):

```
--mode        Set the agent execution mode for this session (accept-edits, plan)
--sandbox     Run in a sandbox with terminal restrictions enabled
--dangerously-skip-permissions
              Auto-approve all tool permission requests without prompting
--conversation  Resume a previous conversation by ID
--continue / -c Continue the most recent conversation
--effort      Reasoning effort (low|medium|high)
```

**Probe** (disposable temp git repo, since deleted), `--mode accept-edits -p`,
asking for one file write and no shell commands:

```
exit=0  elapsed=8s
jetski: no output produced — a tool required the "write_file" permission that
headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under
permissions.allow in settings.json (e.g. write_file(<target>)). Alternatively,
re-run with --dangerously-skip-permissions to auto-approve all tools.
→ PROBE.txt was NOT created
```

Four conclusions, all load-bearing:

1. `--mode accept-edits` **does not** auto-accept edits headlessly. It **fails
   closed** and auto-denies. That is good behaviour by `agy`.
2. There is therefore **no CLI-flag-only safe writable mode**. The adapter's
   original comment was correct that a non-interactive run cannot answer prompts.
3. There *is* a **scoped** mechanism `agy` documents itself:
   `permissions.allow` rules in `settings.json`, e.g. `write_file(<target>)`.
   This is the correct M2 target — it grants file writes while still gating
   commands and network, which is exactly the granularity the approval engine
   wants. Bremio does not use it today.
4. Failing closed is **cheap and safe**: the run returned in 8 s with exit 0. It
   does not hang. So denying by default carries no timeout risk.

Also unused by the adapter: `--sandbox`, `--conversation`, `--continue`. The
adapter declares `resumableSessions: false` and its own code says
*"agy --continue is not wired"* (`antigravity-adapter.ts:258`) — honest, and now
known to be a gap rather than a provider limitation.

### 1.5 OpenCode carries the same defect, unconditionally

`opencode-adapter.ts:160` builds every invocation with `--auto`, on **all**
paths including read-only. `opencode run --help`:

```
--auto  auto-approve permissions that are not explicitly denied (dangerous!)
        [boolean] [default: false]
```

Bremio turns a provider's deliberately-default-off dangerous flag on for every
run. This is the same class of defect as §1.4 and is **not** fixed by the
containment patches — it was outside their approved scope. See §8.

### 1.6 Capability declarations versus reality

| Adapter | Declares | Actually supports | Gap |
|---|---|---|---|
| antigravity | `resumableSessions: false` | `--conversation <id>`, `--continue` | Under-declared; unwired |
| antigravity | `shell: true` | yes, gated by permissions | — |
| claude | interception via `canUseTool` | genuine per-action seam | Only adapter with one |
| codex | `--sandbox read-only\|workspace-write` | provider-enforced sandbox | — |
| opencode | `--agent plan` for read-only | plus unconditional `--auto` | §1.5 |

---

## 2. Semantic model (M-1-T1)

### 2.1 Three independent axes

The previous plan used one `ExecutionMode`. That was wrong: Bremio has three
orthogonal questions, and conflating them is what makes enum and migration
design collapse later.

```ts
/** How many agents collaborate. */
type CollaborationMode = "solo" | "colab";

/** How much authority the system has to cause side effects. */
type ControlMode = "plan" | "approve" | "autopilot";

/** Where the agent's edits land before the user accepts them. */
type WorkspaceStrategy = "direct-workspace" | "isolated-worktree";
```

Persisted values stay as they are. `single` ⇄ `solo` and `team` ⇄ `colab` are
handled by a **codec at the boundary**; no database, report, ledger or protocol
value is rewritten. Renaming stored data carries migration risk without
functional benefit.

### 2.2 Approval granularity and enforcement guarantee

```ts
type ApprovalGranularity = "per-action" | "before-apply" | "none";

type EnforcementGuarantee =
  | "hard-sandbox"        // OS/provider sandbox refuses the operation
  | "provider-native"     // provider's own permission system refuses it
  | "worktree-contained"  // it happens, but not in the user's workspace
  | "advisory"            // only instructions ask it not to
  | "unsupported";
```

**`advisory` is never an acceptable backing for `plan` or `approve`.** A mode
whose only enforcement is a sentence in a prompt must not be offered.

### 2.3 Valid combinations

`approve` **requires** `isolated-worktree` unless the transport offers a genuine
per-action seam. This is the decision that makes review-before-apply work for
providers that own their tool loop.

| Collaboration | Control | Workspace | Valid | Granularity |
|---|---|---|---|---|
| solo | plan | direct | ✅ | none needed — read-only is enforced |
| solo | plan | isolated | ✅ | none needed |
| solo | approve | **direct** | ❌ | cannot review before it has already happened |
| solo | approve | isolated | ✅ | `before-apply` |
| solo | approve | direct + seam | ✅ | `per-action` (Claude only today) |
| solo | autopilot | direct | ⚠️ allowed, explicit | `none` |
| solo | autopilot | isolated | ✅ preferred default | `none` |
| colab | any | isolated | ✅ | as above |
| colab | any | direct | ❌ | worktrees are how Co-lab isolates workers |

**Consequence to state plainly:** *Solo* now means **"one agent"**, not "edits
your files directly". The TUI currently says the latter — `run.tsx` describes
Single Agent as *"one agent, directly in this workspace"*. That copy must change
when Approve ships, and the change is a semantic one, not cosmetic.

### 2.4 Action classes

Policy is written against action classes, never provider names:

```
read · write · create · delete · command · network
mcp-tool · git-destructive · outside-workspace · user-config
```

### 2.5 Autopilot's non-negotiable deny list

**Recorded late — this decision was approved in the `docs/14` Q4 review and was
missing from the first version of this lock.**

These classes are denied under autopilot:

- `outside-workspace` — writes beyond the approved workspace or worktree
- `git-destructive` — force-push and history rewriting
- `user-config` — silent changes to user-level configuration
- privileged/administrator commands
- anything that would exfiltrate secrets
- destructive commands aimed outside the worktree

The first three (`outside-workspace`, `git-destructive`, `user-config`) are
enforced in `AUTOPILOT_RULES` (`packages/policy`). The remaining items depend on
an action-class taxonomy that does not yet exist — they are pinned here so they
are not silently forgotten. No override mechanism exists: `overrideableByGrant`
and the grant-consumption lifecycle (`consumeApprovalGrant`,
`pruneExpiredApprovalGrants`, `expireApprovalRequests`) were deleted in S5-T7
as dead code that nothing called.

---

## 3. Adapter transport capabilities (M-1-T0)

Capabilities belong to **adapter + transport + version**, not to a provider
name. One provider may expose different guarantees over CLI, SDK and app-server.

```ts
interface AdapterRuntimeCapabilities {
  adapterId: string;
  transport: "cli" | "sdk" | "app-server";
  transportVersion?: string;

  readOnlyEnforcement: "hard" | "provider-native" | "advisory" | "none";
  approval: "per-action" | "before-apply" | "none";

  nativeResume: boolean;
  structuredToolEvents: boolean;
  vision: boolean;
  contextMetrics: "reported" | "estimated" | "none";
  manualCompact: boolean;
  mcp: boolean;
  webSearch: boolean;
  cancellation: boolean;
}
```

### 3.1 Probe results

Confidence: **S** = read from source · **H** = provider `--help` · **P** =
executed probe · **I** = inferred · **?** = unknown, not investigated.

| Adapter | Transport | Version | read-only enforcement | Writable path | Per-action seam | Native resume | Evidence |
|---|---|---|---|---|---|---|---|
| claude | sdk | bundled | `canUseTool` denies write tools | `canUseTool` allows | **yes** — `canUseTool` | yes (`resume`) | S |
| codex | cli | installed | `--sandbox read-only` | `--sandbox workspace-write` | no | yes (`exec resume`) | S |
| antigravity | cli | **1.1.5** | `--mode plan` | **none safe headlessly** | no | **`--conversation <id>` exists, unwired** | S+H+P |
| opencode | cli | installed | `--agent plan` **+ unconditional `--auto`** | `--auto` | no | no (probed in B0) | S+H |
| local | http | n/a | all capabilities false by design | — | no | no | S |

Unknown and deliberately not probed (cost/scope): `contextMetrics`,
`manualCompact`, `mcp`, `webSearch` for every adapter; Antigravity TTY-vs-non-TTY
approval streaming; whether `agy --sandbox` composes with `-p`.

### 3.2 Antigravity questions answered

| Question | Answer | Evidence |
|---|---|---|
| Safe writable mode without the bypass? | **No CLI flag.** `accept-edits` auto-denies headlessly | P |
| Scoped alternative? | **Yes** — `permissions.allow` in `settings.json` | H (agy's own error) |
| Interceptable approval stream? | **No** — headless mode cannot prompt at all | P |
| Does it block on a TTY? | No — auto-denies and exits in 8 s | P |
| Plan/read-only mode? | Yes — `--mode plan` | H |
| Native session id / resume? | **Yes** — `--conversation <id>`, `--continue` | H |
| Structured tool events? | Not investigated | ? |

---

## 4. Identity and persistence model (M-1-T2)

### 4.1 Entities

```
Repository 1─* Worktree
Repository 1─* Session
Session    1─* SessionConfigRevision   (append-only; never mutated in place)
Session    1─* ProviderSessionBinding  (one per agent participating)
Session    1─* Run                     (a Run is one Turn of the Session)
Run        1─* Task                    (Co-lab only)
Task       1─1 AgentAssignment
```

### 4.2 Configuration versus runtime facts

| Session configuration (**intent**) | Runtime facts (**outcome**) |
|---|---|
| collaboration mode, control mode, workspace strategy | provider-confirmed model |
| lead agent id, worker agent ids | provider-native session id |
| requested model, reasoning level | actual token usage |
| tools/MCP enabled, cwd, base branch | transport version, degraded capabilities |

**Runtime facts must never reconstruct intent.** §1.1 is precisely what happens
when they do:

```
provider-reported model string  ≠  persisted Bremio agent identity
```

### 4.3 Provider session lineage

```ts
interface ProviderSessionBinding {
  bremioSessionId: string;
  agentId: string;
  transport: string;
  nativeSessionId?: string;
  status: "active" | "lost" | "expired";
  createdAt: string;
  lastUsedAt: string;
}
```

A Co-lab session holds several. When a binding is `lost` or `expired`, the
recovery choice must be **explicit**: native resume · replay transcript · start
fresh from a compacted summary · ask the user · fail with a named reason.
Switching to a different provider is never one of the options.

### 4.4 Legacy provenance

```ts
type RecordProvenance = "native" | "legacy-derived" | "legacy-import";

interface ConfigCompleteness {
  completeness: "complete" | "partial";
  missingFields: string[];
}
```

A session whose configuration was inferred from `runs.lead_provider`/`runs.mode`
is `legacy-derived` and `partial` — it genuinely does not know the requested
model, reasoning level or control mode. On resume:

```
show the derived configuration
→ ask the user to confirm or complete it
→ write a complete revision
→ then continue
```

Global defaults must never silently fill the gaps; that is the same failure as
§1.1 wearing a different hat.

Imported filesystem reports are `legacy-import`: displayed normally, original
timestamps preserved, never claiming data the artifact does not contain.
Artifacts under `.bremio/` are never rewritten.

### 4.5 Repository identity (design only)

```ts
interface RepositoryIdentity {
  repositoryId: string;   // stable, derived from gitCommonDir when available
  canonicalRoot: string;  // normalized separators + case-folded drive letter
  gitCommonDir?: string;
  worktreeId?: string;
}
```

Must survive: Windows vs WSL paths for one repo (`D:\Work\x` vs
`/mnt/d/Work/x`), separator and drive-case variance (already fixed at read time
in `storage.ts` `normalizeRepositoryPath`), symlinks, git worktrees, the same
repo opened by several clients, and directories that are not git repositories.

Deriving identity from `git rev-parse --git-common-dir` is the recommended basis
because it is stable across worktrees; the worktree is then a sub-identity.

---

## 5. Daemon contract (M-1-T3)

The daemon becomes the authority: sole persistent writer, event broadcaster,
process-supervision owner, migration owner, reconciliation owner. CLI and
extension are clients of one protocol.

`bremio run` without a daemon is served by an **ephemeral daemon** using the
same protocol and execution path — not a second in-process implementation. A
genuinely standalone mode, if kept, is named `--standalone` and marks its runs
`persistence: standalone, syncStatus: not-shared`. `--no-daemon` is rejected as
a name because it implies a mere transport detail rather than a data-visibility
decision.

Existing and adequate: `PROTOCOL_VERSION = 2`, `MINIMUM_CLIENT_PROTOCOL = 1`,
`/meta` capability handshake, store-then-publish event ordering, `afterSeq`
replay, single-instance lock. New routes stay additive; bump only when an old
client cannot function.

### 5.1 Honest restart semantics

SSE replay restores **events**, not **control**. After a daemon restart a child
process may be dead, alive but unowned, or finished with no producer. The first
implementation therefore must:

```
restart
→ reconcile runs previously marked active
→ mark interrupted or supervision_lost
→ offer retry / resume
→ never report a run as active without evidence
```

Claiming a process is still controllable is only permitted after a verified
re-adoption. Split into four future tasks: SSE fan-out · replay ·
startup reconciliation · process adoption (optional, later).

---

## 6. Safety harness design (M-1-T4)

Fixtures to build when the corresponding feature lands — **not** added as
failing tests now:

| Fixture | Proves |
|---|---|
| Plan-mode write attempt | enforcement, not instruction |
| Ignored-file write | `git status` alone is insufficient |
| Outside-workspace write | boundary is a path, not a repo |
| Home-directory write | user config is protected |
| Network attempt | network is an action class |
| Wrong-provider resume | §1.1 cannot return |
| Wrong-mode resume | Co-lab does not degrade to Solo |
| Unavailable provider | fails loudly, never substitutes |
| Daemon restart mid-run | reconciliation is honest |
| Two clients, one run | identical event sequences |
| Migration from a **copied real** DB | not just synthetic fixtures |
| Windows/WSL identity | one repo, one identity |

**Plan-mode acceptance must not be "git status is clean."** It must state the
guarantee actually achieved per transport: `hard sandbox verified` ·
`provider-native read-only verified` · `worktree unchanged` ·
`outside-workspace sentinel unchanged` · `known limitations documented`.

---

## 7. Containment patches landed with this document

Scope-limited by design; neither begins M0.

1. **Resume fails closed** — provider and collaboration mode come from
   persisted `runs.lead_provider` / `runs.mode`. No model-string parsing, no
   `claude` default, no silent mode default. Unknown or unavailable → an error
   that names the session, the cause and the next action.
2. **Antigravity dangerous permissions** — `--dangerously-skip-permissions` is
   no longer implied by ordinary `workspace-write`. It requires explicit opt-in;
   without it a writable request fails **before spawn**, so no quota is spent on
   a run that `agy` would auto-deny anyway (§1.4, conclusion 4).

---

## 8. Not actioned

Recorded, deliberately not fixed — each is outside this package's approved scope.

- **OpenCode `--auto` (§1.5).** Same defect class as the Antigravity bypass and
  arguably worse: it is unconditional, applying even to read-only runs, and the
  provider ships it default-off while calling it *"dangerous!"*. Recommended as
  the immediate follow-up to this package, using the identical opt-in shape.
- **`agy --sandbox` unused.** May offer terminal restriction that would raise
  Antigravity's `EnforcementGuarantee` above `provider-native`. Needs a probe.
- **`agy --conversation` unwired.** Antigravity under-declares
  `resumableSessions: false`; native resume exists. Belongs to
  `ProviderSessionBinding` work.
- **`permissions.allow` scoped rules unused.** The correct M2 target for
  granular Antigravity approval — write access without granting commands.
- `bremio session show --max-events <n>` documented but never parsed.
- `config/routing.yaml` resolves from `process.cwd()`, so routing depends on the
  invocation directory rather than the repository.
- `RunOutcome` has `error?: string` but no error code, so adapters cannot
  transmit `classifyAgentError`'s classification.

---

## 9. Amendments to `docs/14`

1. **`M2-T0` becomes `M-1-T0`.** Capability probing gates the design of
   `M0-T4` and `M2-T1`; it cannot sit in M2. Done in this document.
2. **First executable task is `M0-T1a`, not `M0-T2`.** `docs/14` named M0-T2
   first on product value, which was right, but it depends on M0-T1's schema.
3. **New foundation tasks:** canonical repository/worktree identity ·
   provider session binding and resume strategy · legacy config provenance ·
   daemon startup reconciliation · ephemeral daemon execution · `ApprovalGrant`
   with an immutable action digest · isolated-worktree review-before-apply.
4. **Splits** (previously undersized):
   - *Session config*: schema+migration · read/write API · legacy backfill and
     provenance · revision semantics · provider binding · resume integration.
   - *CLI through daemon*: client+handshake · connection/startup · start run ·
     SSE rendering · cancellation · default cutover · ephemeral · report import.
   - *Diff review*: change model · attribution · API · panel viewer ·
     apply/revert · conflict handling.
   - *Compact*: measurement · summary artifact · manual · provider-native ·
     automatic thresholds.
5. **Approval needs `ApprovalGrant`, not only `ApprovalRequest`** — scopes
   (once / session / workspace), expiry, revocation, precedence, first-decision
   -wins across concurrent clients, and an immutable action digest so an
   approved command cannot be substituted before execution.

### 9.1 Implementation order after this package

```
M0-T1a  session config schema + transactional migration
M0-T1b  session config read/write API
M0-T1c  legacy backfill + provenance
M0-T2   resume from persisted config + provider binding
M0-T3   policy engine (pure, no adapters)
M0-T4   plan enforcement + isolated worktree
M0-T5   canonical repository/worktree identity
M1-*    daemon client, handshake, run-through-daemon, reconciliation
M2-*    approval lifecycle, change attribution, diff review
```

---

## 10. Remaining unknowns

- Does `agy --sandbox` compose with `-p`, and what does it restrict?
- Exact `permissions.allow` grammar and whether it can be scoped per-run
  (repo-local `settings.json`) rather than per-user.
- Whether `agy` emits structured tool events Bremio could attribute changes from.
- `contextMetrics` / `manualCompact` / `mcp` / `webSearch` for every adapter.
- Whether Codex's app-server transport exposes an interception seam the CLI does
  not — the case that motivates transport-level capabilities in the first place.
