# Flow E: prepare a session (design)

Approved by Iñigo on 24 Nov 2026 ("keep the suggestion, go ahead"). PRD: Flow E, T-10.

## Why

Right before a session the therapist wants the picture in one read: what happened last time,
what the patient did at home since, pain, anything worrying, and what to focus on today. It is
the clearest "data put to use" moment of the product (PRD: "The data is dead").

## What the therapist sees

📋 *Preparar sesión* → patient picker (same as Flow B: recent patients by number, or a typed or
spoken name, any patient of the clinic) → one message, then the next step.

```
📋 *Laura Méndez · preparar sesión*

*Última sesión (20 nov):* dolor 3/10. Flexión de rodilla 115°, cuádriceps 4/5; se acordó trabajar fuerza de cuádriceps.
*Desde entonces (4 días):* ejercicios 3 de 4 días (2 completos, 1 parcial). Sentadilla en pared: no la hizo 2 veces («muy difícil»).
*Actividad:* correr 25 min, dolor 5/10 frente de la rodilla desde el min 20.
⚠️ *Alerta:* …            (only when a red flag was logged)
*Sugerencia para hoy:* revalorar fuerza de cuádriceps; bajar la sentadilla en pared; hablar del volumen de carrera.

¿Algo más con *Laura Méndez*?
1. 📝 Nota de esta sesión  2. 📋 Preparar otra  3. 🏠 Menú principal  4. ✅ Es todo
```

Under ~120 words for a normal patient. Empty states say so plainly ("Sin notas de sesión
todavía", "Sin plan de casa", "Sin registros del paciente desde la última sesión").

## Approaches

1. **Code computes every fact; the AI writes only the condensed last-session line and the
   suggestion, grounded in numbered facts (picked).** Numbers, dates, adherence and pain are
   rendered by code, so they can't be wrong; the AI adds the readable summary and the focus.
2. The AI writes the whole brief from raw rows. Shortest code, but numbers can be invented and
   the length drifts; against the "AI invents when it can't read" lesson.
3. Facts only, no suggestion. Safest, but loses the PRD's suggested focus (Iñigo chose to keep it).

## Rules

- Reads confirmed rows only (`sessions.status = 'confirmed'`). Writes nothing.
- "Since then" = the days after the last confirmed session's clinic date, through yesterday
  (today's check-in usually hasn't happened). Exercise days: a day counts as *completo* when every
  logged exercise was done, *parcial* when some were, *no los hizo* when none, *sin respuesta*
  when there is no log. Skipped exercises are listed by name with how often, plus the patient's
  comment when there is one.
- Activity: the three most recent activity logs since the last session, "+N más" beyond that.
  Red-flag logs get the ⚠️ line.
- The AI gets a numbered list of facts and returns `last_session` (one line, from the last
  note) and up to 3 suggestions, each citing the fact numbers it is based on. Code drops any
  suggestion that cites no valid fact, and any AI line containing a number that is not in the
  facts. If the AI call fails or everything is dropped, the brief is sent without those parts
  (the last-session line falls back to pain and the note's plan text).
- The suggestion is labelled as a suggestion; it never states a diagnosis.
- Next step: 📝 Nota de esta sesión (straight into Flow B for that patient), 📋 Preparar otra,
  🏠 Menú principal, ✅ Es todo.

## Testing

Pure logic (window, adherence, activity lines, guards, formatting, word count) in
`prep-logic.ts` / `prep-format.ts`, checked by `scripts/check-flow-e.mts`. A script seeds
synthetic patient logs for the test patient Laura Méndez Ruiz (`scripts/seed-prep-logs.ts`),
then the simulator runs the flow as Terapeuta Simulador.

## Left to the builder

Exact wording of empty states, the AI prompt, how many skipped exercises to list (max 3).
