Audit the Cliniko integration conservatively. Do not change anything.

Goals:
1. Identify all Cliniko integration touchpoints.
2. Map auth, config, request, response, and error handling paths.
3. Determine what Cliniko behavior is verified by code vs assumed.
4. Identify missing contract and regression coverage.
5. Flag anything that may require consulting Cliniko public API docs.

Output format only:

## 1) Integration map
- files/touchpoints:
- purpose:
- call paths:

## 2) Auth and config
- credential sources:
- env/config usage:
- uncertainty:

## 3) Request/response handling
- request builders:
- response mapping:
- error/retry/timeout behavior:
- uncertainty:

## 4) Coverage
- tested:
- untested:
- risky assumptions:

## 5) Next validation step
- smallest high-value check:

## 6) Questions
- only questions required to reduce uncertainty

Rules:
- no edits
- do not assume Cliniko behavior if not verified from code
- if repo evidence is insufficient, say exactly what is uncertain
- if public Cliniko docs are needed, say what must be checked and why
- be concise
- be token efficient
- keep bullets short
