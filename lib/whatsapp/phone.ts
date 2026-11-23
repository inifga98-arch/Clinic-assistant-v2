/**
 * Normalise a phone number or Twilio WhatsApp address to the form stored in the database:
 * E.164, no "whatsapp:" prefix, no spaces.
 *
 *   "whatsapp:+5215512345678" -> "+5215512345678"
 *   "+52 55 1234 5678"        -> "+5215512345678"
 *
 * Mexican mobiles: WhatsApp identifies them with a "1" after the country code (+52 1 ...).
 * Twilio delivers incoming messages from that form, and the Sandbox only sends to it (a reply
 * to +52 without the 1 fails with error 63015). So we store and send the +521 form, and add
 * the 1 when a 10-digit Mexican number is typed without it.
 */
export function normalizePhone(raw: string): string {
  let phone = raw.trim().replace(/^whatsapp:/i, "").replace(/[\s\-().]/g, "");
  if (!phone.startsWith("+")) phone = `+${phone}`;
  const mxWithoutOne = /^\+52(\d{10})$/.exec(phone);
  if (mxWithoutOne) phone = `+521${mxWithoutOne[1]}`;
  return phone;
}

/**
 * Every stored form a normalised number may have been saved in. Someone editing a row by hand
 * in Supabase may type a Mexican mobile without the 1, so lookups try both.
 */
export function phoneVariants(phone: string): string[] {
  const normalized = normalizePhone(phone);
  const mx = /^\+521(\d{10})$/.exec(normalized);
  return mx ? [normalized, `+52${mx[1]}`] : [normalized];
}

/** The address format Twilio expects for WhatsApp sends. */
export function toWhatsAppAddress(phone: string): string {
  return `whatsapp:${normalizePhone(phone)}`;
}
