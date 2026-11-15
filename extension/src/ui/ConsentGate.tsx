/**
 * Shows the disclosure instead of the page until the person accepts it.
 * Wrapped around every extension page; the service worker enforces the same
 * rule for background fetching, so a closed page cannot be a way around it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { acceptConsent, CONSENT_KEY, DISCLOSURE, hasConsent } from "@/src/consent/consent";

function Section({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

export function ConsentGate({ children }: { children: ReactNode }) {
  const [consented, setConsented] = useState<boolean | null>(null);

  useEffect(() => {
    void hasConsent().then(setConsented);
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && CONSENT_KEY in changes) void hasConsent().then(setConsented);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  if (consented === null) return null;
  if (consented) return <>{children}</>;

  return (
    <main className="mx-auto max-w-xl bg-white p-5 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <h1 className="text-lg font-semibold">Before Canvas Archiver starts</h1>
      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
        It uses the Canvas, Gradescope and Ed sessions you are already signed in to, and keeps the result on this computer.
      </p>
      <Section title="What it reads" items={DISCLOSURE.reads} />
      <Section title="Where it writes" items={DISCLOSURE.writes} />
      <Section title="Optional features" items={DISCLOSURE.optional} />
      <Section title="What it never does" items={DISCLOSURE.never} />
      <button
        type="button"
        className="mt-5 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        onClick={() => void acceptConsent()}
      >
        I understand, start
      </button>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Until you click, nothing is read. You can withdraw later in Settings, or remove the extension.
      </p>
    </main>
  );
}
