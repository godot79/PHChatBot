Propose the smallest high-value regression test batch for this repository. Do not make changes.

Base the plan on:
- current production behavior
- existing test coverage
- highest-risk business flows
- external integration boundaries

Prioritize:
1. Meta webhook verification and inbound handling
2. booking orchestration flows
3. Cliniko integration boundaries
4. failure, retry, timeout, and config error paths
5. idempotency / duplicate webhook handling if relevant

Output format only:

## 1) Proposed batch
For each test:
- behavior:
- risk reduced:
- test type: unit | integration | contract
- mocks/dependencies:
- production code change required: yes | no

## 2) Why this batch first
- shortest justification only

## 3) Blockers
- testability issues:
- missing fixtures/mocks:
- required production seam, if any:

## 4) Smallest required production diff
- none | brief description

## 5) Questions
- only questions required to reduce uncertainty

Rules:
- no edits
- do not refactor production code unless explicitly approved
- test observable behavior, not implementation details, unless necessary
- be concise
- be token efficient
- do not assume
- keep bullets short
