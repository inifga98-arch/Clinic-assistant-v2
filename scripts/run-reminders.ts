// Run the reminder scheduler once from a terminal (the cron endpoint does the same).
//
//   npm run reminders -- --dry                        print instead of sending
//   npm run reminders -- --dry --now 2026-11-24T19:05  pretend it's that clinic time
//
// Without --dry, reminders go out through Twilio for real. Uses the shared Supabase database.

import { runReminders } from "@/lib/agents/patient/reminders";
import { setTransport } from "@/lib/whatsapp/send";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const nowArg = args[args.indexOf("--now") + 1];
const now = args.includes("--now") && nowArg ? new Date(`${nowArg.slice(0, 16)}:00-06:00`) : new Date();

if (dry) {
  setTransport(async (msg) => {
    const text = msg.kind === "text" ? msg.body : `[template ${msg.contentSid}] ${JSON.stringify(msg.variables)}`;
    console.log(`\n  Bitácora → ${msg.to}:\n${text.replace(/^/gm, "    ")}`);
    return `SIM${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  });
}

async function main() {
  console.log(`Reminder run at ${now.toISOString()}${dry ? " (dry run, nothing is sent)" : ""}`);
  const result = await runReminders(now);
  console.log(`\n${JSON.stringify(result)}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
