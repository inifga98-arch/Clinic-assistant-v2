// Numbered option lists (pure). Shared by both agents through lib/whatsapp/send.ts, which
// re-exports Option. No runtime imports so scripts/check-*.mts can test it.

export interface Option {
  id: string; // what the agent gets back when the user picks it
  title: string; // shown to the user (WhatsApp limit: 20 chars for buttons, 24 for list rows)
  /** Optional emoji shown before the title. Matching ignores it, so typing the title still works. */
  icon?: string;
}

/** "Body\n\n1. 📝 Nota de sesión\n2. …" until real WhatsApp buttons exist. */
export function formatOptions(body: string, options: Option[]): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.icon ? `${o.icon} ` : ""}${o.title}`);
  return `${body}\n\n${lines.join("\n")}`;
}
