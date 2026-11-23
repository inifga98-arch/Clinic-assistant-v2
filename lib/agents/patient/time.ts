// Clinic-local dates and times (pure). The pilot clinic is in Mexico City.
// Mexico City has had no daylight saving time since 2022, so the offset is a fixed UTC-6.

export const CLINIC_TIME_ZONE = "America/Mexico_City";
const CLINIC_UTC_OFFSET = "-06:00";

/** Today's date (YYYY-MM-DD) and weekday (0 = Sunday) in the clinic's time zone. */
export function clinicToday(now = new Date()): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekdays.indexOf(get("weekday")) };
}

/** A clinic-local date and "HH:MM[:SS]" as a UTC instant. */
export function clinicTimeToUtc(date: string, time: string): Date {
  return new Date(`${date}T${time.slice(0, 5)}:00${CLINIC_UTC_OFFSET}`);
}
