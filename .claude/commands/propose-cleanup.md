Propose the smallest safe cleanup batch for this repository. Do not make changes.

Output format only:

## 1) Safe now
For each item:
- path:
- action: edit | archive | delete
- why:
- evidence:
- minimal diff:

## 2) Needs confirmation
For each item:
- path:
- proposed action:
- why:
- evidence:
- uncertainty:

## 3) Uncertain / investigate further
For each item:
- path or area:
- concern:
- evidence:
- what to verify next:

## 4) Recommended batch
- include only the smallest safe group of changes worth doing now

Rules:
- no edits
- no rewrites
- archive over delete when safer
- remove only clearly outdated, redundant, or misleading comments
- do not touch behavior unless required
- be concise
- be token efficient
- if uncertainty exists, say so explicitly
- keep each bullet short
