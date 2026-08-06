# Claude Code Rules

Production repo: Cloud Run WhatsApp booking bot with Meta webhooks and Cliniko integration.

## Core rules
- Be concise.
- Be token efficient.
- Read before changing.
- Never make assumptions.
- If uncertain, ask targeted questions.
- Never do broad rewrites.
- Prefer minimal, local, reversible edits.
- Preserve architecture unless explicitly told otherwise.
- Never silently refactor.
- Never rename, move, delete, or rewrite files without approval.
- Never make unrelated improvements.
- When the user has already answered prior uncertainty questions, do not re-ask them. Convert confirmed answers into the smallest concrete next action.
- At the start of each session working in this repo, check the `project-deferred-items` memory for open/known-but-deferred issues before starting new work — surface anything relevant rather than waiting to be asked.

## How to investigate a suspected bug (do not guess)
Never diagnose from a symptom alone ("tests are flaky," "this looks like network flakiness," "add a retry"). Measure the actual behavior first, form a hypothesis from the data, calibrate a fix against real numbers, then verify the fix with the same measurement method that found the problem. Guessing-then-patching is not acceptable even if the patch happens to help.

**Worked example (2026-08-06, live-Cliniko test flakiness):**
1. Initial (wrong) move: assumed "network flakiness," added a blind retry-once-on-429 and a test-file lock without measuring anything. This helped a little but didn't explain or fix the real problem — called out as guessing, not engineering.
2. Corrected approach: instrumented every real `SendMessage.get()` call with timestamp + worker PID + outcome, ran the actual failing suite, and analyzed the resulting log (concurrency-over-time sweep, request-rate-over-time buckets) instead of theorizing.
3. Found the real pattern from the data: a 5-second burst of ~149 real requests (~30 req/s) was immediately followed by ~45-50 seconds of total lockout — every request failed regardless of pacing, not a soft throttle recovering gradually.
4. Calibrated a safe threshold empirically against the live account (not guessed): concurrency 3/5/8 sustained for 10s each — zero failures up to ~18 req/s (concurrency 8, 180 requests). Concurrency 15 (the actual production `BULK_CONCURRENCY_LIMIT` at the time) reliably tripped the lockout within ~6 seconds.
5. This pinpointed the actual root cause: `BULK_CONCURRENCY_LIMIT = 15` (set for a *different*, earlier problem — gateway timeouts) was high enough to trip Cliniko's real rate limit on its own, from ordinary production traffic (Book Soonest's catalogue build fans out to ~30-40 practitioners) — a real production risk, not just test noise.
6. Fix was the calibrated value (8, the highest empirically-zero-failure point), with the calibration numbers written into the code comment and a pinned regression test, plus a live verification re-running the actual production fan-out function (not a synthetic script) against every real practitioner to confirm zero failures.

Apply this shape to any "flaky," "sometimes fails," "seems slow," or "network issue" report in this repo: instrument and measure the real system first (logs, counters, timing), form a hypothesis only from that data, calibrate any threshold/limit/timeout against real behavior rather than picking a number, and verify the fix the same way the problem was found — not just "tests pass now."

## Change protocol
For any non-trivial task:
1. Briefly state understanding.
2. State unknowns/risks.
3. Propose the smallest next step.
4. Implement the change on a feature branch, run the Jest suite, and run feasible local live verification (local dev server / manual test harness — never against live Cliniko/production data without separate explicit approval).
5. Show the diff preview together with the Jest and live-verification results.
6. Wait for approval.
7. Apply/keep only approved changes.
8. Summarize exact changes.

Post-merge staging deploy verification (confirming the `chatbot-webhook-staging` Cloud Run service) is the user's own step, done after merge to staging `main` — not part of the pre-approval loop above.

## Dev & deploy workflow
- All dev work happens in `~/CodingProjects/PHChatBot-staging`, not in this (`PHChatBot`) directory.
- All dev work happens on feature branches — never commit directly to `main`.
- After dev + testing in the feature branch: merge it to `main` in the staging directory, then deploy that staging-directory `main` to the `chatbot-webhook-staging` Cloud Run service.
- Once the staging deploy is confirmed working: push the staging directory's `main` upstream to `origin/main`.
- This (`PHChatBot`) directory is deploy-only for production: `git pull` from upstream, then deploy that pulled state to the `chatbot-webhook` (prod) service with no further changes made here.

## Repo review mode
When asked to review the repo:
- Identify:
  - runtime entrypoints
  - Meta webhook verification and inbound flow
  - booking orchestration
  - Cliniko integration points
  - storage/state handling
  - deployment/config
  - test structure and gaps
- Distinguish verified facts from uncertain findings.
- Do not propose speculative fixes.

## Cleanup policy
Before changing anything, classify items as:
- definitely unused
- likely unused
- uncertain
- deprecated but still referenced

For each deletion/move proposal, provide evidence from:
- code references/imports
- tests
- scripts
- Docker/build/deploy config
- runtime wiring where relevant

Prefer:
- `_archive/` for deprecated code
- small safe deletions
- removal of outdated/redundant comments only

## Test policy
- Treat tests as first-class code.
- Clean up broken, duplicated, obsolete, or low-value tests before adding coverage.
- Before writing new tests, explain:
  - what behavior is currently verified
  - what is unverified
  - highest regression risks
- Prefer tests around business behavior and integration boundaries.
- Avoid brittle tests tied to implementation details unless necessary.
- Comments must sound human.
- Remove robotic, redundant, or obvious comments.

## Known bug classes — check on every relevant audit
- **Unpaginated interactive lists.** WhatsApp interactive lists/buttons must page (5 items page 0, 4 items page 1+, or the buttons/list ≤3-vs-paginated threshold already used in `ChatbotEngine.js`) — an unpaginated list of more than a handful of rows pushes the Send button off-screen (incident 2026-07-19, recurred in `_stepTypeInsurer`'s insurer menu, fixed 2026-08-06). Any audit of a menu-rendering code path (new or existing) must check it pages correctly, not just that it renders.
- **Insurer selection is centralized in `_stepTypeInsurer`** (`ChatbotEngine.js`) — the single canonical implementation, called by all 5 booking flows (History, Specific Date, Specific Physio, Specific Clinic, Book Soonest). Book Soonest's funnel bridges into it via a scratch `data.selected_appt_type` object inside `_stepApptFunnel`'s insurer stage (always cleared before returning). Any change to insurer-selection behavior (auto-apply, self-pay reset, pagination, prompt copy) belongs in `_stepTypeInsurer`, not duplicated per-flow. If a future change touches insurer logic in only one flow's handler, that is itself a red flag to investigate.

## Cliniko policy
- If Cliniko behavior is not clear from the repo, say so.
- If needed, consult Cliniko public API docs before proposing implementation or test changes.
- For live integration testing:
  - never run against live data without explicit approval
  - prefer read-only checks first
  - clearly state risks and prerequisites

## Output format
Use:
1. Understanding
2. Unknowns
3. Proposed next step
4. Diff preview (if any)
5. Wait for approval

## Priority
Correctness > safety > minimality > speed
