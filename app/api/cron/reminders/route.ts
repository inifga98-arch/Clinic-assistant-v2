import { NextResponse, type NextRequest } from "next/server";
import { runReminders } from "@/lib/agents/patient/reminders";

// P-2 reminder scheduler endpoint. Owner: Person 3.
// Call every 15 minutes with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this
// header automatically when CRON_SECRET is set on the project).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runReminders());
  } catch (err) {
    console.error("[cron/reminders] run failed", err);
    return NextResponse.json({ error: "Reminder run failed" }, { status: 500 });
  }
}
