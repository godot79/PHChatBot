# Chatbot Funnel Feature — Status & Rehydration Prompt

**Branch:** `main` (all changes uncommitted)  
**Last updated:** 2026-07-17  
**Tests:** 548 passed, 0 failed (10 skipped — live Cliniko tests requiring credentials)

---

## What this change does

Implements **saved appointment preferences** for the WhatsApp chatbot:

1. New `patient_state` table (`phone_number PK, region TEXT, appt_preference TEXT, updated_at`) created at startup in SQLite.
2. `region` is written to `patient_state` whenever a user picks a region in the INTRO flow.
3. At session start, `patient_state` row is loaded into `session.context`, overriding any prior-session values.
4. The old flat appointment-type list is replaced by a 4-step progressive funnel: **Service → Patient Type → Insurer → Duration** (steps auto-advance when only 1 option exists).
5. On funnel resolution, user's choice (`service`, `patientType`, `insurer`, `duration`) is saved to `patient_state.appt_preference` and `session.context.appt_preference`.
6. On next booking: funnel shows "Last time: [label] — Book the same again?" shortcut with Yes / Change buttons.

---

## Files changed

| File | What changed |
|------|-------------|
| `src/core/DatabaseManager.js` | `patient_state` table in `initialize()`; `getPatientState()`; `upsertPatientState()` with COALESCE partial-update |
| `src/core/SessionManager.js` | After session seed: loads `patient_state` row into `session.context` |
| `src/core/_appointmentTypeHelpers.js` | Added `buildFunnelCatalogue(rawTypes)`, `resolveApptFromFunnel(catalogue, sel)` |
| `src/core/ChatbotEngine.js` | Added `_stepApptFunnel()`, `_formatPrefLabel()`, `_saveFunnelPref()`; BOOK_SOONEST choose_type block replaced; back-nav updated; region write-through in INTRO (3 places); `CLEAR_FIELDS_BY_STEP` updated |
| `tests/unit/core/appointmentTypeHelpers.test.js` | New file: unit tests for `buildFunnelCatalogue` and `resolveApptFromFunnel` |
| `tests/integration/chatbot.integration.test.js` | In-memory DB mock updated; `resetCliniko()` types include `category`/`duration_in_minutes`; `FUNNEL_CAT_1`/`FUNNEL_CAT_2` constants; BOOK_SOONEST tests updated |

---

## Pending work

- [ ] Wire `_stepApptFunnel` into **BOOK_SPECIFIC_DATE** — both inline (after date pick) and standalone choose_type block
- [ ] Wire into **BOOK_SPECIFIC_PHYSIO** — build `funnel_catalogue` from `apptTypes` for the specific physio
- [ ] Wire into **BOOK_SPECIFIC_CLINIC** — build `funnel_catalogue` from flattened `allClinicTypes`
- [ ] Write integration tests for each updated handler
- [ ] BOOK_HISTORY: leave untouched (explicit decision)

---

## Key implementation details

### `buildFunnelCatalogue(rawTypes)`
- Each raw type must have `category` (string) and `duration_in_minutes` (number)
- `category` format: `"Insurer : Service"` (insured) or `"Service"` (self-pay)
- Filters UWC and Online Booking types
- Returns `[{ id, name, service, insurer, patientType, duration }]`

### `_stepApptFunnel(session, data, text)` — in ChatbotEngine
- Caller must pre-build `data.funnel_catalogue` before calling
- State machine: `data.funnel_step` (`shortcut | service | patient_type | insurer | duration`) + `data.funnel_sel`
- Auto-advance loop skips steps with only 1 option when `text === ''`
- Returns `{ reply: MessageEnvelope }` (still collecting) or `{ resolved: {name, ids, norm_name} | null }` (done)
- On resolve: calls `_saveFunnelPref(session, sel)` (fire-and-forget)

### `_saveFunnelPref(session, sel)` — critical caveat
- `session.context` may be a raw JSON string from the DB row — method parses before assigning `appt_preference`
- Fires `upsertPatientState(...).catch(() => {})` — non-blocking

### BOOK_SOONEST funnel wiring pattern (reference implementation)
```js
if (!Array.isArray(data.funnel_catalogue)) {
  const { list, map } = await buildTypeCatalogue();  // also sets data.funnel_catalogue
  data.appointment_type_list = list;
  data.appt_type_name_to_ids_norm = map;
  data.appt_type_page = 0;
  await sync({ conversation_state: this.STATES.BOOK_SOONEST });
}
if (!(data.funnel_catalogue || []).length) {
  data.no_slots_prompt = { context: 'soonest' };
  await sync({ conversation_state: this.STATES.BOOK_SOONEST });
  return buttons('No appointment types are available right now.', [...3 options...]);
}
if (!data.selected_appt_type) {
  const funnelResult = await this._stepApptFunnel(session, data, text);
  await sync({ conversation_state: this.STATES.BOOK_SOONEST });
  if (funnelResult.reply) return funnelResult.reply;
  if (!funnelResult.resolved) {
    data.no_slots_prompt = { context: 'soonest' };
    await sync(...);
    return buttons('No appointment types are available right now.', [...]);
  }
  data.selected_appt_type = funnelResult.resolved;
  await sync();
}
// ... physio / slot building continues
```

### Back-nav: clearing funnel state
- Pop `choose_physio` → `choose_type`: clear `funnel_step`, `funnel_sel`, `funnel_catalogue`
- `CLEAR_FIELDS_BY_STEP.choose_type` includes `funnel_catalogue`, `funnel_step`, `funnel_sel`

### Test constants
```js
const FUNNEL_CAT_1 = { id: 'AT-001', name: 'Initial 60 Min Visit (New Clients)', service: 'Physiotherapy', insurer: null, patientType: null, duration: 60 };
const FUNNEL_CAT_2 = { id: 'AT-002', name: 'Return Visit (Existing Clients)',    service: 'Physiotherapy', insurer: null, patientType: null, duration: 30 };
```
- Seed `funnel_catalogue: [FUNNEL_CAT_1]` → funnel auto-resolves (single entry, no prompts needed)
- Seed `funnel_catalogue: [FUNNEL_CAT_1, FUNNEL_CAT_2]` → funnel stops at duration step (2 options)

### `resetCliniko()` default types — both must include `category` and `duration_in_minutes`
```js
{ id: 'AT-001', ..., category: 'Physiotherapy', duration_in_minutes: 60 }
{ id: 'AT-002', ..., category: 'Physiotherapy', duration_in_minutes: 30 }
```
Both instance-mock restoration blocks (end of BOOK_SPECIFIC_CLINIC concurrency test + end of BOOK_SOONEST concurrency test) must also include these fields.

---

## Rehydration prompt

Paste this to resume work in a new session:

```
Continue the saved-appointment-preferences feature on `main` in /Users/godot/CodingProjects/PHChatBot.

Read REHYDRATION_CHATBOT_FUNNEL.md first — all context is there.

Summary: funnel (_stepApptFunnel) is wired into BOOK_SOONEST only. Three handlers remain:
1. BOOK_SPECIFIC_DATE — wire funnel into choose_type block + inline after date pick; write tests
2. BOOK_SPECIFIC_PHYSIO — build funnel_catalogue from apptTypes for specific physio; write tests
3. BOOK_SPECIFIC_CLINIC — build funnel_catalogue from flattened allClinicTypes; write tests
4. BOOK_HISTORY — leave untouched

Use the BOOK_SOONEST block in ChatbotEngine.js as the reference wiring pattern.
Key rule: session.context arrives as a raw JSON string from DB rows — parse before property access.

Run `npm test -- --testPathPattern=integration` to verify no regressions after each handler.
```
