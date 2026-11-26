# Ask about a patient after the prep brief (design)

Approved by Iñigo on 26 Nov 2026 (approach A, "A, go ahead"). Follows Flow E
(`2026-11-24-flow-e-design.md`).

## Why

The brief is a summary and a dead end. Before a session the therapist wants to dig in, the way
they'd ask a colleague who knows the file: "¿desde cuándo le duele al correr?", "¿cómo iba la
flexión al principio?", "¿por qué sugieres bajar la sentadilla?", "¿progreso a 4 series?". Both
kinds of question: what happened (from the record) and what to do (an opinion). Opinions must be
clearly marked as suggestions.

## What the therapist sees

After the brief: `1. 💬 Preguntar sobre su historial  2. 📝 Nota de esta sesión  3. 📋 Preparar
otra  4. 🏠 Menú principal  5. ✅ Es todo`. Choosing 1, or just typing or saying a question, starts
the conversation:

```
💬 Pregúntame lo que quieras sobre *Laura Méndez Ruiz*: sesiones, plan, dolor, ejercicios…
```

Each answer:

```
📂 *Según el expediente:*
• La flexión pasó de 95° a 115°. (nota 6 nov; nota 20 nov)
• El dolor al correr aparece desde el 18 nov. (registro 18 nov)

💡 *Sugerencia de la IA (no es del expediente):* si hoy tolera la sentadilla sin dolor, progresar a 4 series.

Escribe o di otra pregunta, o:
1. 📝 Nota de esta sesión
2. 🏠 Menú principal
```

When nothing in the record answers it: "📂 No lo encuentro en el expediente." (plus a suggestion
only if one makes sense). "menu"/"cancelar" work as everywhere.

## Approaches

- **A. Free conversation over the whole record (picked).** What Iñigo described; reuses the
  brief's grounding; the record loader is also the core of Flow F (handoff).
- B. A fixed drill-down menu (pain over time, past sessions, adherence, why the suggestion).
  Safest, but not a conversation and can't answer "¿qué harías…?".
- C. A + quick buttons. More to build and read; add buttons later only if the same questions
  keep coming.

## How it works

- **The record ("expediente")** is built by code each question, as numbered entries with a
  code-made label: the patient (diagnosis, reason, doctor), the confirmed initial evaluation,
  every confirmed note (newest 25), every plan with its dates, exercise adherence per week, each
  activity log (newest 60, red flags marked). Confirmed rows only; nothing is written.
- **The model** gets the record, the last 3 questions and answers, and the question. It returns
  record statements, each citing entry numbers, and at most one suggestion.
- **Guards (code):** a record statement survives only if it cites a valid entry and every
  number in it appears in the cited entries (same unit rules as the brief); its sources are
  rendered by code from the entries' labels, so dates can't be invented. The suggestion is
  never shown as a fact; it always carries the 💡 label. If every statement is dropped, the
  answer says it isn't in the record.
- **Inputs:** text or voice (transcribed); photos are deleted and reported; the conversation
  lives in the conversation state (expires after 30 minutes like every flow).
- One answer fits one WhatsApp message (clipped, ≤ 1,600 with options).
- If the model call fails or times out (25 s): "No pude responder ahora. Intenta de nuevo." and
  the conversation stays open.

## Also

The seed script marks its rows in `pain_duration` instead of the comment, so test text no longer
shows in the ⚠️ alert.

## Left to the builder

Prompt wording, how the evaluation is condensed into one entry, exact clipping lengths.
