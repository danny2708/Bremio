# 99 — Risks & Open Questions

> Read this before writing the first line of code. This is where the
> project is most likely to die.

## Load-bearing risks (ordered by danger)

**R1 — Duplication with AI-Quota-Tray.** The hardest piece (official quota)
already exists in the same Side-Projects directory. If Bremio re-reads
quota itself = writing the hardest piece of logic twice. → Consume AQT;
quota is Phase 4, not the MVP.

**R2 — Antigravity auth is a different capacity pool.** The official SDK uses
Gemini API-key or Vertex credentials; it does not reuse the Antigravity IDE
login/subscription whose quota AQT observes. → report SDK auth separately and
never route from IDE quota as though it guaranteed SDK execution capacity.

**R3 — Antigravity shell is not workspace-sandboxed.** SDK file policies are
workspace-scoped, but `run_command` can still mutate outside that boundary.
→ disable shell for read-only runs and keep Antigravity out of test gates until
the SDK exposes both a stronger sandbox and reliable command exit codes.

**R4 — Handoff loss can make multi-agent worse than single.** An agent
receiving a plan loses the original agent's reasoning. → baseline = best
single agent; enforce `outcome ≥ baseline` + the single-agent escape hatch.

**R5 — Escalation double-pay.** Cheap-first guessing wrong means paying
twice. → only enable cheap-first after the calibration gate; escalate the
correct stage, never raise both reasoning and model tier at once.

**R6 — Scope creep (MVP turning into v1.0).** Scheduler + router + 3
adapters + worktrees + quota + extension all inside "MVP" is a planning-
fallacy signal. → lock Phase 1 to Claude+Codex sequential; everything else
explicitly out of scope.

## ROI & sequencing (Chief-of-Staff)

80/20: the biggest pain (context-switching + quota) can likely be solved
~80% of the way by **AI-Quota-Tray (quota) + a thin sequential CLI dispatcher
(a single entry point)** — before touching the team/worktree/review
machinery. Worth considering shipping that thin slice first, measuring, then
expanding.

## Must VERIFY before coding (all post-cutoff, changing fast)
- [x] Claude Agent SDK TS → current `query()` async stream, abort controller,
      tool permissions, usage/result events, and `outputFormat: json_schema`
      are integrated and passed real Single/Team fixtures.
- [x] Codex execution surface → selected `codex exec --json` for the v0.1
      one-shot adapter; real JSONL fixtures verified streaming events,
      structured output, cancellation, and provider identity.
- [x] Codex RPC `account/rateLimits/read` → retained behind AI-Quota-Tray;
      Bremio consumes AQT's normalized schema-v1 multi-window cache rather than
      duplicating the provider RPC.
- [x] Antigravity programmatic surface → official `google-antigravity==0.1.7`
      inspected and integrated through a JSONL Python sidecar.
- [x] Where/how AQT writes its quota cache → confirmed schema-v1 SQLite under
      AQT's LocalAppData directory; Bremio reads it read-only.

## Decisions resolved during v0.1
- [x] **Q-quota-integration**: read AQT's schema-v1 SQLite cache directly and
      read-only for the first integration. Reject unknown schema versions and
      keep it out of routing until fresh-data calibration succeeds.
- [x] **Q-lang**: repository code and documentation stay in English;
      collaborator conversation may use Vietnamese with English technical
      terms.
- [x] **Q-baseline**: Single outcome requires recognizable successful command
      evidence; Team outcome is the fail-closed test plus independent-review
      quality gate. Controlled comparisons link identical requests through
      `comparisonId`; missing model/cost evidence blocks efficiency claims.
