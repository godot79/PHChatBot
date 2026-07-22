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

## Change protocol
For any non-trivial task:
1. Briefly state understanding.
2. State unknowns/risks.
3. Propose the smallest next step.
4. Show minimal diff preview.
5. Wait for approval.
6. Apply only approved changes.
7. Summarize exact changes.

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
