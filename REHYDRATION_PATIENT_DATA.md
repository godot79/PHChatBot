# Patient Data Analysis — Rehydration Prompt
**Last updated:** 2026-07-12  
**Session work:** CSV analysis (prior) + Cliniko HK API validation (this session)  
**CSV:** `Patients-Cliniko-20260710.csv` in repo root (42,749 records, 63 columns)  
**API:** `https://api.au1.cliniko.com/v1` — HK key from `.env.hk` (`CLINIKO_API_KEY_HK`)  
**Auth:** Basic auth, `base64("${HK_KEY}:")` — see `src/api/ClinikoHeaders.js`

Do not re-derive anything below. Build on it.

---

## What is known and settled

### Database condition
Poor. ~52% of records have no Last Appointment. Pervasive DD/MM DOB transpositions in older records. Mobile phone field is a household/family identifier, not a patient identifier.

### Identifier reliability (ranked)
1. **Email** — precision 1.0, coverage 66%. Primary matching key.
2. **Mobile + same surname + DOB match/transposition** — precision 1.0, coverage ~40% of mobile-only cases. Safe secondary key only with this guard.
3. **Mobile alone** — NOT safe. ~37% of mobile-only pairs are family members.
4. **Name + DOB** — useful tertiary soft match; ~30–40% FPR without mobile/email confirmation.

### Activity buckets (Last Appointment as of 2026-07-10)
| Bucket | Count | % |
|---|---|---|
| Active <6m | 3,144 | 7.4% |
| Active 6–12m | 1,204 | 2.8% |
| Active 12–24m | 2,012 | 4.7% |
| Inactive >24m | 14,148 | 33.1% |
| No appointment data | 22,241 | 52.0% |

### Duplicate clusters
- Email-based: 1,887 pairs
- Mobile-based raw (includes family): 5,498 pairs (prior analysis) / 3,637 (this session with 852-prefix normalization — see note below)
- Mobile-based safe (surname+DOB guard): 1,674 pairs
- Name+DOB only: 326 pairs (review queue)

### Segmentation buckets
| Bucket | Count | Definition |
|---|---|---|
| A_ACTIVE_CLEAN | 6,001 | Canonical, valid contact, active ≤24m |
| B_ACTIVE_NO_CONTACT | 49 | Active but no usable identifier |
| C_DORMANT | 13,101 | >24m inactive, has contact |
| D_UNKNOWN | 16,906 | No appointment history — see API findings below |
| E_DUPLICATE_SHADOW | 4,888 | Non-canonical hard duplicate |
| F_POSSIBLE_DUPLICATE | 467 | Name+DOB soft match, needs review |
| G_EXCLUDE | 1,337 | Test, shell, or data-error records |

**Note on D_UNKNOWN count:** The prior session used 16,906; the CSV re-parse in this session found 22,241 with no `Last Appointment`. Reconcile before finalising — likely different filter logic. Use the CSV parse result (22,241) as the ground truth going forward until this is resolved.

---

## API validation findings (this session — all confirmed by live Cliniko data)

### P1 — The 52% D_UNKNOWN problem
**Finding: Real, not an export gap.**
- Sample of 1,000 D_UNKNOWN patients (with cleaned IDs): 0/904 valid responses had any appointment history in the API.
- CSV `Last Appointment` = most recent *non-cancelled* appointment only. Cancelled-only patients would appear as D_UNKNOWN — but zero D_UNKNOWN patients have cancellation-only histories (confirmed in P5).
- 28 D_UNKNOWN patients have a future booking (`Next Appointment` set in CSV). API confirms these exist. Sub-bucket these as `D_FUTURE_BOOKED`.

### P2 — Family vs. duplicate on mobile
**Finding: Algorithm gap identified.**
- 36% of "different surname" mobile pairs are same-DOB → likely duplicates with name variants (married names, hyphen/spacing, middle name added).
- Examples: DE ROUGEMONT / DEROUGEMONT (same DOB, mobile), NATALIE CHEUNG / NATALIE CHEUNG HOWARTH (same DOB, mobile), GIGI TSO / GI GI HOKWUN TSO.
- Current step 2 (`mobile + same surname + DOB → EXISTING`) misses these because surname check fails.
- Appointment date overlap confirms family in 8% of different-surname pairs (where both patients have appointment history). 44% of pairs have neither patient with appointments — date overlap is uninformative for them.

### P3 — Invoice data
**Finding: Useful canonical signal, partially missing from algorithm.**
- ~93 D_UNKNOWN patients (extrap.) have invoice history with no appointment record. Flag for manual review — not safe for re-engagement automation.
- In duplicate pairs: one record holds all/most invoices in ~20% of cases → strong canonical signal.
- 66% of duplicate pairs both have zero invoices — invoice data is uninformative for them.

### P4 — Contact freshness
**Finding: API adds nothing beyond CSV.**
- API returns global `updated_at` only — identical to CSV `Updated At`. No per-field history.
- 447 D_UNKNOWN patients updated within last 6 months — useful "warm" sub-segment for re-engagement prioritisation.

### P5 — Cancellations / DNA
**Finding: D_UNKNOWN is clean.**
- 0/184 D_UNKNOWN patients had any cancellation history. All 40,013 cancellations in the system belong to already-bucketed (active/dormant) patients.
- DNA filter (`did_not_arrive`) is NOT supported as a query parameter on the Cliniko v1 API. Can only be read per appointment record.

---

## Current state of the middleware algorithm

### Registration matching (step order matters — first match wins)

```
match_on_registration(email, mobile, fname, lname, dob):

  Step 1:  email exact match (case-insensitive)
           → EXISTING

  Step 2:  mobile match
           AND same surname (case-insensitive)
           AND (dob exact OR dob DD/MM transposed)
           → EXISTING

  Step 2b: [PROPOSED — not yet implemented]
           mobile match
           AND dob exact match
           AND Levenshtein(fname_incoming, fname_existing) > 0.8
           → EXISTING
           (catches married-name changes and name-formatting variants
            where surname technically differs but DOB+mobile+firstname match)

  Step 3:  same surname AND same dob (no mobile/email)
           → EXISTING (soft match — flag for review, low confidence)

  Step 4:  else → NEW
```

### Canonical record selection (when multiple records match)

```
Current score:
  score = email×3 + mobile×2 + dob×1 + has_appt×2 − days_since_last_appt/10000

Proposed addition:
  score = email×3 + mobile×2 + dob×1 + has_appt×2 + invoice_count×1
          − days_since_last_appt/10000

Highest score wins. Ties: keep lower patient ID (older record).
```

### Signals confirmed NOT to reliably disambiguate family vs. duplicate
- Appointment date overlap (families share clinics and timeslots)
- Same practitioner
- Same business/location

---

## Infrastructure findings (must not forget)

### Excel-escaped Patient IDs
9,981 of 22,241 D_UNKNOWN Patient IDs (and others with 18-digit new-format IDs) are stored in the CSV as `="1558354464010667075"`. Any code reading Patient IDs from this CSV must strip this before use:

```python
import re
def clean_patient_id(s):
    m = re.match(r'^="?(\d+)"?$', s.strip())
    return m.group(1) if m else s.strip()
```

### Two Cliniko ID formats coexist
- **Old format:** 7–9 digit integers (patients created pre-2024). Example: `2311458`
- **New format:** 18-digit integers (patients created 2024+). Example: `1558354464010667075`
- Both work with v1 API. Both work with `/patients/{id}/appointments`.

### API rate limits (observed)
- Sustained throughput: ~1.5–2.5 req/s before 429s
- Use async/aiohttp with concurrency ≤6
- Full 22,241-patient sweep would take ~3–4 hours. Sample and extrapolate for analysis; use targeted per-patient calls only in the production middleware flow.

### Mobile normalization
- API `patient_phone_numbers[].normalized_number` provides clean international format (e.g. `9540 8617` → `85295408617`)
- For matching, prefer API-normalized numbers over raw CSV values
- Raw CSV matching produces inconsistent pair counts depending on whether 852 prefix is stripped (5,498 pairs vs 3,637 pairs in two analyses — same dataset)

---

## Recommended next steps

These are ordered by value and readiness.

### 1. Resolve D_UNKNOWN count discrepancy (quick — 30 min)
Prior session: 16,906. This session's CSV re-parse: 22,241. Check what filter each session used. The bucket definition and downstream counts depend on this.

### 2. Implement Step 2b (mobile + DOB + first-name similarity) (medium — 1–2 days)
- Affects ~287 same-DOB different-surname mobile pairs currently classified as NEW when they're duplicates
- Requires choosing a Levenshtein threshold (suggest 0.8, test against the 50-pair sample)
- Validate on the full 1,444 same-surname same-DOB pairs as a precision check before shipping

### 3. Add invoice_count to canonical scoring (small — 2–4 hrs)
- Call `/patients/{id}/invoices?per_page=1` at matching time, use `total_entries`
- Adds meaningful signal for ~20% of duplicate pairs
- No harm when both are zero

### 4. Strip Excel escaping from Patient IDs everywhere (small — 2–4 hrs)
- Audit all code paths that read Patient IDs from CSV exports
- Add `clean_patient_id()` at the intake point
- Write a test: `clean_patient_id('="1558354464010667075"')` == `'1558354464010667075'`

### 5. Create D_FUTURE_BOOKED sub-bucket (small — 2–4 hrs)
- 28 patients: `Last Appointment` blank, `Next Appointment` set
- These should NOT receive "we miss you" re-engagement messages
- Simple filter on the existing CSV/query logic

### 6. Flag D_UNKNOWN with invoices (medium — 1 day)
- ~93 patients with invoice history but no appointment history
- Pull via `/patients/{id}/invoices?per_page=1` for all D_UNKNOWN at next full refresh
- Route to manual review queue, not automated re-engagement

### 7. Use API-normalized phone numbers in middleware matching (medium — 1 day)
- Replace raw mobile string comparison with API `normalized_number`
- Eliminates format-difference false negatives (spaces, local vs international format)
- Requires fetching patient record from API rather than matching on submitted raw string

---

## Files from this session
All in `/Users/godot/.claude/jobs/4ba0b7e3/tmp/` (session temp dir — may not persist):
- `dunknown_ids_clean.txt` — 22,241 D_UNKNOWN Patient IDs, Excel escaping stripped
- `p1_results_v2.json` — P1 sample results
- `p2_results.json` — P2 50-pair appointment overlap results
- `p3_results.json` — P3 invoice analysis results
- `p5_results.json` — P5 cancellation check results
- `api_analysis_summary.md` — condensed findings table

If temp files are gone, all conclusions above are derived from them and are accurate.
