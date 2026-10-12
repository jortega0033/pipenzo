import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';
import { README_URL, STATUS_SUMMARY } from '../content.js';

/**
 * Status drawn as two board columns, the shape the product itself uses for tickets. The split is
 * the substance: nothing moves from the right column to the left one on this page until it has
 * moved in README.md's "What exists today".
 */
export function StatusSection() {
  return (
    <section
      id="status"
      aria-labelledby="status-heading"
      className="border-b border-border bg-surface/40 py-24 sm:py-28"
    >
      <Container>
        <SectionHeading
          index="08"
          label="status"
          id="status-heading"
          title="Status: early, actively being built"
        >
          <p>
            We'd rather show you an honest split than a polished roadmap graphic. This is what's
            merged today, and what's designed but still being wired in.
          </p>
        </SectionHeading>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <Column title="Built and tested" tone="ok" items={STATUS_SUMMARY.built} />
          <Column title="Designed, being wired in" tone="warn" items={STATUS_SUMMARY.inProgress} />
        </div>

        <p className="mt-8 text-sm text-text-faint">
          Full breakdown, updated as it actually changes, in{' '}
          <a
            href={README_URL}
            className="text-text-soft underline underline-offset-2 hover:text-text"
          >
            README.md's "What exists today"
          </a>
          .
        </p>
      </Container>
    </section>
  );
}

function Column({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'ok' | 'warn';
  items: readonly string[];
}) {
  const ok = tone === 'ok';
  return (
    <div className="rounded-pipenzo bg-surface-2 p-3 sm:p-4">
      <div className="flex items-center justify-between px-2 pb-3 pt-1">
        <h3
          className={`text-sm font-semibold uppercase tracking-wide ${ok ? 'text-accent' : 'text-warn'}`}
        >
          {title}
        </h3>
        <span
          className="rounded-full bg-surface-3 px-2 py-0.5 font-mono text-xs text-text-soft"
          aria-hidden="true"
        >
          {items.length}
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-3 rounded-pipenzo bg-surface p-4 text-sm leading-relaxed text-text-soft shadow-elevated-sm"
          >
            {ok ? (
              <svg
                viewBox="0 0 16 16"
                className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 16 16"
                className="mt-0.5 h-4 w-4 shrink-0 text-warn"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="5.5" />
                <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
              </svg>
            )}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
