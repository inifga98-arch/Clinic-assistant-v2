# Flow B simulator scripts (Spanish)

Each `.txt` is one message per line. Run as a therapist:

    npm run simulate -- --as inigo < test_inputs/ws2_sessions/es/<script>.txt

The AI wording changes from run to run; check the behaviour, not the exact text.
Scripts marked **saves** write a permanent, locked note (use Carlos Méndez or Valeria Soto,
never Ana López, whose data the CRM and patient agent build against).

| Script | What it checks | Expect |
| --- | --- | --- |
| `clean.txt` (saves) | One complete note | Review, then "Guardado…" with the next reminder |
| `multi.txt` | Three notes, then Listo | "nota 1/2/3", one combined note, discarded |
| `missing_pain.txt` (saves) | Demo step 3 | One pain question, "3", review, saved |
| `skip_assessment.txt` | "omitir" | Review lists "Falta: valoración", discarded |
| `correction.txt` | Typed corrections | Only the corrected value or item changes |
| `correction_voice.txt` | Spoken correction at review | Dorsiflexión changes to 20°, nothing else |
| `no_changes.txt` (saves) | "Sin cambios en el plan de casa" | Same active plan id afterwards |
| `two_anas.txt` | Name matches two patients | "¿Cuál de ellos?" in alphabetical order |
| `name_in_note.txt` | Note sent before picking a patient | "¿La nota es de Valeria Soto?" |
| `discard.txt` | Descartar | "No se guardó nada", no draft row left |
| `resume.txt` | Draft survives a reset | Resume offer on "Nota de sesión", Continuar works |
| `review_fixes.txt` | Notes before the name, "Sí, pero…" correction, empty edit | Both notes kept; correction applied (not saved); back to review; discarded |

Not pipeable (two messages at the same instant), run by hand once the state is right:

- `concurrent.txt`: after picking a patient, send two notes at once:
  `npm run simulate -- --as inigo "Nota A…" & npm run simulate -- --as inigo "Nota B…" & wait`
  → "nota 1" and "nota 2", and both appear in the note after Listo.
- `double_confirm.txt` (saves): at the review, send `"1"` twice the same way
  → one "Guardado…", one "Esta nota ya estaba guardada.", one plan.

`audio/correccion_dorsiflexion.mp3` is synthetic (OpenAI TTS).
