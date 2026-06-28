Review this repository conservatively. Do not change any files.

Goals:
1. Understand the real production flow.
2. Map the code before proposing changes.
3. Identify safe cleanup candidates.
4. Audit tests before adding new ones.

Output format only:

## 1) Architecture
- Entrypoint(s):
- Core flow:
- Integrations:
- State/storage:
- Deploy/config:

## 2) Webhook flow
- Verification path:
- Inbound message path:
- Booking path:
- Response path:
- Uncertainties:

## 3) Cliniko
- Touchpoints:
- Auth/config:
- Key assumptions:
- Uncertainties:

## 4) Tests
- Test areas:
- Strong coverage:
- Weak/missing coverage:
- Test quality issues:

## 5) Cleanup candidates
For each item:
- path:
- status: definitely unused | likely unused | uncertain | deprecated but still referenced
- reason:
- evidence:

## 6) Questions
- only questions required to reduce uncertainty

Rules:
- be concise
- be token efficient
- do not assume
- do not edit
- do not propose broad rewrites
- distinguish verified facts from uncertainty
- provide evidence when claiming something may be unused
- keep each bullet short
