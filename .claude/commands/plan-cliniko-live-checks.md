Propose a minimal live Cliniko integration test plan. Do not run anything and do not change code.

Goals:
1. Verify real Cliniko connectivity safely.
2. Prefer read-only validation before any mutation.
3. Minimize risk to live data and live operations.
4. Identify prerequisites for safe execution.

Output format only:

## 1) Read-only checks
For each check:
- goal:
- endpoint/action:
- expected safe outcome:
- risk:

## 2) Prerequisites
- required credentials:
- required env/config:
- required test data or sandbox:
- uncertainty:

## 3) Safety constraints
- what must not be written:
- rollback/cleanup needs if writes are ever approved:
- operational risks:

## 4) Smallest execution plan
- command/script shape:
- manual vs scripted:
- stop conditions:

## 5) Questions
- only questions required to reduce uncertainty

Rules:
- no edits
- no execution
- no write operations
- do not assume a sandbox exists
- do not assume live data is safe to touch
- be conservative
- be concise
- be token efficient
- keep bullets short
