// WhatsApp simulator: talk to the real router and agents from a terminal, no Twilio needed.
//
//   npm run simulate -- --list                         who you can be
//   npm run simulate -- --as marina "hola"             one message as Marina, then exit
//   npm run simulate -- --as cherub                    interactive chat as Cherub
//   npm run simulate -- --as inigo --audio test_inputs/ws2_sessions/audio/s1_clean_vn1.mp3
//   npm run simulate -- --as inigo --reset             forget where that person is in a flow
//
// Uses the shared Supabase database from .env.local (real rows, real conversation state).
// Replies are printed here instead of sent, and logged in `messages` with ids starting "SIM".
// Voice notes are transcribed with the real OpenAI key.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { IncomingMessage } from "@/lib/agents/types";
import { db } from "@/lib/db/server";
import { processIncoming } from "@/lib/router";
import { recordIncoming } from "@/lib/router/inbox";
import { saveState } from "@/lib/router/state";
import { allowLocalMedia, audioTypeForPath } from "@/lib/whatsapp/media";
import { normalizePhone } from "@/lib/whatsapp/phone";
import { normalizeText, setTransport } from "@/lib/whatsapp/send";

interface Person {
  name: string;
  phone: string;
  role: "therapist" | "patient" | "unknown";
}

const HELP = `Interactive commands:
  /audio <file>   send a voice note (mp3, ogg, m4a, wav)
  /as <name>      switch person
  /reset          forget where this person is in a flow
  /list           show everyone you can be
  /quit           exit`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`${header()}\n\n${HELP}`);
    return;
  }

  const people = await loadPeople();
  if (args.list) {
    printPeople(people);
    return;
  }

  const who = args.as ?? process.env.SIM_AS;
  if (!who) {
    console.log("Say who you are with --as <name or phone> (or set SIM_AS in .env.local).\n");
    printPeople(people);
    process.exitCode = 1;
    return;
  }
  let person = pickPerson(who, people);
  allowLocalMedia(); // voice notes come from local files here, not Twilio URLs

  setTransport(async (msg) => {
    const text = msg.kind === "text" ? msg.body : `[template ${msg.contentSid}] ${JSON.stringify(msg.variables)}`;
    const target = normalizePhone(msg.to) === person.phone ? person.name : msg.to;
    console.log(`\n  Bitácora → ${target}:\n${indent(text)}`);
    return `SIMOUT${randomUUID().replace(/-/g, "")}`;
  });

  if (args.reset) {
    await saveState(person.phone, person.role === "patient" ? "patient" : "therapist", null);
    console.log(`Cleared the conversation state for ${person.name}.`);
  }

  if (args.audio || args.message) {
    await send(person, args.message ?? "", args.audio);
    return;
  }
  if (args.reset) return;

  // Interactive chat.
  console.log(`Chatting as ${person.name} (${person.role}, ${person.phone}). /help for commands.`);
  // Iterate lines (not rl.question) so pasted or piped lines queue up while a reply runs.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let closed = false; // piped input closes readline at EOF while queued lines still run
  rl.on("close", () => (closed = true));
  const prompt = () => {
    if (closed) return;
    rl.setPrompt(`\n${person.name} > `);
    rl.prompt();
  };
  prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!process.stdin.isTTY) console.log(line); // echo piped input so the transcript reads well
      if (line === "/quit" || line === "/exit") break;
      if (!line) {
        prompt();
        continue;
      }
      if (line === "/help") console.log(HELP);
      else if (line === "/list") printPeople(people);
      else if (line === "/reset") {
        await saveState(person.phone, person.role === "patient" ? "patient" : "therapist", null);
        console.log("  (state cleared)");
      } else if (line.startsWith("/as ")) {
        try {
          person = pickPerson(line.slice(4).trim(), people);
          console.log(`  (now ${person.name}, ${person.role})`);
        } catch (err) {
          console.log(`  ${(err as Error).message}`);
        }
      } else if (line.startsWith("/audio ")) {
        await send(person, "", line.slice(7).trim()).catch((err) => console.log(`  ${(err as Error).message}`));
      } else if (line.startsWith("/")) console.log(`  Unknown command. ${HELP}`);
      else await send(person, line);
      prompt();
    }
  } finally {
    rl.close();
  }
}

async function send(person: Person, body: string, audioPath?: string) {
  const media = [];
  if (audioPath) {
    const path = resolve(audioPath);
    if (!existsSync(path)) throw new Error(`No such audio file: ${audioPath}`);
    media.push({ url: pathToFileURL(path).href, contentType: audioTypeForPath(path) });
  }
  const message: IncomingMessage = {
    sid: `SIM${randomUUID().replace(/-/g, "")}`,
    phone: person.phone,
    body: body.trim(),
    buttonPayload: null,
    media,
    receivedAt: new Date(),
  };
  await recordIncoming(message);
  await processIncoming(message);
}

async function loadPeople(): Promise<Person[]> {
  const [therapists, patients] = await Promise.all([
    db().from("therapists").select("full_name, phone").eq("active", true).not("phone", "is", null),
    db().from("patients").select("full_name, phone").not("phone", "is", null),
  ]);
  if (therapists.error) throw new Error(`Could not read therapists: ${therapists.error.message}`);
  if (patients.error) throw new Error(`Could not read patients: ${patients.error.message}`);
  // Normalise like the webhook does with Twilio's From, so a simulated message uses the same
  // phone (and conversation state) as a real one, even if the row was typed by hand.
  return [
    ...therapists.data.map((t) => ({ name: t.full_name as string, phone: normalizePhone(t.phone as string), role: "therapist" as const })),
    ...patients.data.map((p) => ({ name: p.full_name as string, phone: normalizePhone(p.phone as string), role: "patient" as const })),
  ];
}

/** Find a person by phone, or by a name fragment ("marina", "inigo", "ana lopez"). */
function pickPerson(query: string, people: Person[]): Person {
  if (/^[+\d][\d\s()-]+$/.test(query)) {
    const phone = normalizePhone(query);
    return people.find((p) => p.phone === phone) ?? { name: phone, phone, role: "unknown" };
  }
  const q = normalizeText(query);
  const matches = people.filter((p) => normalizeText(p.name).includes(q));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Nobody matches "${query}". Use --list to see names.`);
  const exact = matches.filter((p) => normalizeText(p.name) === q);
  if (exact.length === 1) return exact[0];
  throw new Error(`"${query}" matches ${matches.map((m) => m.name).join(", ")}. Be more specific.`);
}

function printPeople(people: Person[]) {
  for (const role of ["therapist", "patient"] as const) {
    console.log(role === "therapist" ? "Therapists:" : "\nPatients:");
    for (const p of people.filter((x) => x.role === role)) console.log(`  ${p.name.padEnd(22)} ${p.phone}`);
  }
}

interface Args {
  as?: string;
  audio?: string;
  message?: string;
  list: boolean;
  reset: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, reset: false, help: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--as") args.as = argv[++i];
    else if (a === "--audio") args.audio = argv[++i];
    else if (a === "--list") args.list = true;
    else if (a === "--reset") args.reset = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}. Try --help.`);
    else words.push(a);
  }
  if ((args.as === undefined && argv.includes("--as")) || (args.audio === undefined && argv.includes("--audio"))) {
    throw new Error("--as and --audio need a value.");
  }
  if (words.length) args.message = words.join(" ");
  return args;
}

function header() {
  return "Bitácora WhatsApp simulator: npm run simulate -- --as <name|phone> [message] [--audio file] [--reset] [--list]";
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

main()
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 50));
