Audit the test suite conservatively. Do not change anything.

Goals:
1. Understand what behavior is already covered.
2. Identify weak, obsolete, duplicate, brittle, or low-value tests.
3. Identify the highest-risk regression gaps.
4. Propose the smallest safe cleanup batch before adding new tests.

Output format only:

## 1) Test inventory
- Areas covered:
- Main test types:
- Notable helpers/fixtures:
- Gaps in organization:

## 2) Coverage summary
- Well covered:
- Partially covered:
- Not covered:

## 3) Test quality issues
For each item:
- path:
- status: obsolete | duplicate | brittle | low-value | uncertain
- reason:
- evidence:

## 4) Regression gaps
For each item:
- behavior:
- risk:
- suggested test type:
- blocking issue, if any:

## 5) Smallest safe cleanup batch
- safe now:
- needs confirmation:
- uncertain:

## 6) Questions
- only questions required to reduce uncertainty

Rules:
- no edits
- do not change production code
- do not add tests yet
- prefer behavior-focused evaluation over implementation details
- be concise
- be token efficient
- do not assume
- keep each bullet short
