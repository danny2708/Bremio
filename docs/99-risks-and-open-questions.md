# 99 — Risks & Open Questions

> Read this before writing the first line of code. This is where the
> project is most likely to die.

## Load-bearing risks (ordered by danger)

**R1 — Duplication with AI-Quota-Tray.** The hardest piece (official quota)
already exists in the same Side-Projects directory. If Bremio re-reads
quota itself = writing the hardest piece of logic twice. → Consume AQT;
quota is Phase 4, not the MVP.

**R2 — Antigravity non-TTY swallows output.** `agy -p` under a subprocess
can return empty while exiting 0. Trusting the exit code alone means the
orchestrator thinks it "succeeded" while nothing happened. → pty wrapper +
defensive parsing; test this case specifically before integrating.

**R3 — Antigravity can't be forced read-only.** `-p` auto-approves every
write. An Antigravity reviewer could be prompt-injected into writing/
deleting files. → throwaway worktree, no secrets granted.

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
- [ ] Claude Agent SDK TS: current startRun/stream/structured-output API.
- [ ] Codex: `codex exec` vs `codex app-server --stdio` — which one gives
      streaming + turn control.
- [ ] Codex RPC `account/rateLimits/read` — current schema (cross-check
      against AQT's code).
- [ ] `agy --help` on the actual machine: confirm `-p`, `--model`, real
      non-TTY behavior.
- [ ] Where/how AQT writes its quota cache → how Bremio reads it back.

## Open questions (not yet resolved)
- [ ] **Q-quota-integration**: read AQT's cache file, or split the
      official-source logic into a shared package for both projects?
      (affects coupling)
- [ ] **Q-lang**: docs/code fully in English going forward, or keep
      Vietnamese + English technical terms?
- [ ] **Q-baseline**: what exactly measures a task's `outcome` (tests
      passing? review findings? subjective?) — needs a definition before
      multi-vs-single comparisons are meaningful.
