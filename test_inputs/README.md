# Test inputs

> Ported from v1. The message scripts, voice-note audio and `expected/` outputs are still valid
> test cases; the `python scripts/...` commands below belong to v1. In Bitácora, send each line
> with `npm run simulate -- --as <name> "<line>"` (or paste them into interactive mode) and
> voice notes with `npm run simulate -- --as <name> --audio <file>` (see CLAUDE.md).

One folder per workstream. Each `*.txt` file is a sequence of messages: every non-empty line is
one WhatsApp message (lines starting with # are ignored). Send them with the simulator:

    python scripts/simulate.py --file test_inputs/ws2_sessions/s1_clean.txt

Then answer the agent the way a therapist would, for example:

    python scripts/simulate.py "yes"

Compare what you get with `expected/`. To test real voice notes, turn the scripts into audio
(`python scripts/make_audio.py`) and send one with `python scripts/simulate.py --audio <file>`,
or play it into WhatsApp from your phone.

Reset the demo data between runs with `python scripts/seed.py --reset` (deletes everything,
reloads the 3 seeded patients). Coordinate before resetting: it affects the whole team.
All patients are synthetic.
