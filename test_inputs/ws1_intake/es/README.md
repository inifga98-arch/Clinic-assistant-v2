# Flow A simulator scripts (Spanish)

One message per line. Run as a therapist, with no open drafts:

    npm run simulate -- --as inigo < test_inputs/ws1_intake/es/<script>.txt

The test patients are made up: **Lucía Prueba Uno** (+52 55 0000 9101) and **Laura Méndez Ruiz**
(+52 55 0000 9102) were registered once for testing. The scripts below don't save anything
(they end in Cancelar / Descartar / Después). Form photos: `../forms/`, drawn by
`scripts/make-test-forms.py` (synthetic, no clinic branding).

| Script | What it checks | Expect |
| --- | --- | --- |
| `register_cancel.txt` | Registration by text | Card with +52 55 0000 9103 and the reason; Cancelar saves nothing |
| `duplicate_number.txt` | A seed patient's number | "Ese número ya es de *Carlos Méndez*" with 📝 / 🩺 / 🗑️ |
| `therapist_number.txt` | A therapist's number | "Ese número es de un terapeuta" |
| `eval_photo.txt` | 3 pages of the MI form | Review in form order, no unreadable fields, "Revisa … contra el papel"; Descartar |
| `eval_wrong_form.txt` | Someone else's form (MS, Carlos) | "⚠️ El formato es de *Carlos Prueba Ramírez*, no de *Lucía Prueba Uno*" |
| `eval_blurry.txt` | Blurry page | Date of birth blank and listed under "No se pudo leer" (never a made-up date) |
| `eval_voice.txt` | Voice evaluation + a correction | Transcription echoed; only the corrected value changes |
| `eval_later.txt` | ⏭️ Después | "Puedes hacerla después desde el menú" |

Not pipeable: photos sent together (WhatsApp multi-select). After choosing 📷, run three
`npm run simulate -- --as inigo --image …` at once (`&` … `wait`) → pages 1, 2 and 3 all kept.
