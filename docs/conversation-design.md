# Conversation design: how Bitácora talks on WhatsApp

Both agents (therapist and patient) follow these rules. Therapists and patients use Bitácora in
spare minutes between other things, on a phone, often by voice. If a message makes them think
or type more than needed, they stop using it. Every rule below exists for that reason.

Flow B (the therapist's session note, `lib/agents/therapist/`) applies all of them; use it as the
reference implementation. Runtime product rules (one question per message, no clinical advice
from the patient agent, confirmations in code, not by the AI) are in `CLAUDE.md`.

## 1. Every choice is a numbered list with an icon

Send choices with `sendOptions` and give each option an `icon` (one emoji). The icon is shown
before the title; matching ignores it, so the user can reply with the number, the title, or a
tap once real buttons exist.

```ts
const MENU: Option[] = [
  { id: "session_note", title: "Nota de sesión", icon: "📝" },
  { id: "prep", title: "Preparar sesión", icon: "📋" },
];
```

```
¿Qué quieres hacer?

1. 📝 Nota de sesión
2. 📋 Preparar sesión
```

Use the same icon for the same meaning everywhere:

| Meaning | Icon | | Meaning | Icon |
| --- | --- | --- | --- | --- |
| Confirm, done, yes | ✅ | | Edit, correct | ✏️ |
| No, not today | ❌ | | Discard, delete | 🗑️ |
| Add another | ➕ | | Continue | ▶️ |
| Voice note received | 🎙️ | | A note, a record | 📝 |
| Pain | 🩹 | | Exercise | 💪 |
| Activity (run, gym) | 🏃 | | Reminder, time | ⏰ |
| Partly, some | 🟡 | | Warning, red flag | ⚠️ |

One icon per option, no decoration inside sentences. Emojis are signposts, not mood.

## 2. Show what you understood before it counts

Voice transcription and AI extraction make mistakes. Before anything is saved, show the person
what Bitácora understood, in their own words, and offer a way to fix it without starting over.

- After a voice note, echo the transcription: `🎙️ Anotado (nota 2). Esto entendí: «…»`, with
  ✏️ Corregir as an option. Don't add a separate "¿Es correcto?" question: the echo plus
  Corregir costs nothing when it's right and one tap when it's wrong.
- Before saving structured data (a SOAP note, a pain log, an activity), show the summary and
  what will be saved. A plain-words correction ("fueron 30 minutos") changes only that part.

## 3. Tell people what a good answer looks like

When you ask for free text or a voice note, say what to include and in what order, with a short
example. People give better answers when they know the shape.

- Therapist note: the S/O/A/P guide (`SOAP_GUIDE` in `note-format.ts`), shown whenever a note
  starts or resumes.
- Patient activity: *qué hiciste, cuánto tiempo y si te dolió (0 a 10)*, plus an example.

## 4. One question per message, and never a dead end

- Ask one thing at a time. If something is missing, ask for that one thing ("¿Qué dolor
  sentiste, del 0 al 10?"), with a way to skip when skipping is safe.
- Every message ends with a next step: options, or a clear "responde *Listo* cuando termines".
- Errors say what to do next: "No pude escuchar tu nota de voz. ¿La mandas otra vez o la
  escribes?", never just "Error".
- Accept the natural answer as well as the option: "sí", "listo", "3/10", a typed name. But only
  a whole-message "sí" counts as yes; "Sí, pero fueron 30 minutos" is a correction.

## 5. Short, warm, in their language

- Mexican Spanish, *tú*, first name. One or two short sentences before the options.
- Bold the key word with `*…*` (the patient's name, the action): "Guardado en el expediente de
  *Ana López*."
- Say what happened and what happens next: "Anotado. Tu terapeuta lo verá antes de tu próxima
  sesión."
- Therapists: efficient and professional, clinical terms are fine.
- Patients: encouraging, plain words, celebrate effort ("¡Bien hecho! 💪"), but never clinical
  advice or a judgement about their recovery (rule X-4).

## 6. Respect WhatsApp's limits

- One message body is at most 1,600 characters. Split longer content into several messages
  and send the options last (see `formatReview` / `formatAck` in `note-format.ts`).
- Real buttons (max 3) and list pickers (max 10 rows, 24-character titles) need Twilio Content
  Templates. Until then, keep option titles under 24 characters so they will fit when we switch.

## Checklist for a new message

- [ ] Does it ask one thing, and say what a good answer looks like?
- [ ] Does every choice have a number and an icon from the table?
- [ ] If it follows a voice note or AI output, does it show what was understood, with a way to fix it?
- [ ] Does it end with a next step?
- [ ] Is it under 1,600 characters, in es-MX, with the key word in bold?
