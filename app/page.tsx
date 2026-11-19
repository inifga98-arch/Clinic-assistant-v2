export default function Home() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Bitácora</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        Expediente clínico para clínicas de fisioterapia, desde WhatsApp.
      </p>
      <p className="mt-8 text-sm text-neutral-500">
        El CRM (lista de pacientes, expediente y exportación a PDF) vive en <code>app/(crm)/</code>.
      </p>
    </main>
  );
}
