/**
 * Normalise a Twilio WhatsApp address to the E.164 form stored in the database.
 *
 *   "whatsapp:+5215512345678" -> "+525512345678"
 *
 * Mexican mobile numbers often arrive with the legacy "1" after the country code (+52 1 ...).
 * We store them without it so a number typed in the CRM and the one WhatsApp sends match.
 */
export function normalizePhone(raw: string): string {
  let phone = raw.trim().replace(/^whatsapp:/i, "").replace(/[\s\-().]/g, "");
  if (!phone.startsWith("+")) phone = `+${phone}`;
  const mxLegacyMobile = /^\+521(\d{10})$/.exec(phone);
  if (mxLegacyMobile) phone = `+52${mxLegacyMobile[1]}`;
  return phone;
}

/** The address format Twilio expects for WhatsApp sends. */
export function toWhatsAppAddress(phone: string): string {
  return `whatsapp:${normalizePhone(phone)}`;
}
