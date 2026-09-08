import { Container } from '../components/Container.js';
import { README_URL, STATUS_SUMMARY } from '../content.js';

export function StatusSection() {
  return (
    <section aria-labelledby="status-heading" className="border-b border-border py-20">
      <Container>
        <h2 id="status-heading" className="text-3xl font-bold text-text">
          Status: early, actively being built
        </h2>
        <p className="mt-4 max-w-2xl text-text-soft">
          We'd rather show you an honest split than a polished roadmap graphic. This is what's
          actually merged, nothing more, nothing dressed up.
        </p>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-accent">
              Built and tested
            </h3>
            <ul className="mt-4 space-y-3">
              {STATUS_SUMMARY.built.map((item) => (
                <li key={item} className="rounded-pipenzo bg-surface p-4 text-sm text-text-soft shadow-elevated-sm">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">
              Designed, being wired in
            </h3>
            <ul className="mt-4 space-y-3">
              {STATUS_SUMMARY.inProgress.map((item) => (
                <li key={item} className="rounded-pipenzo bg-surface p-4 text-sm text-text-soft shadow-elevated-sm">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-8 text-sm text-text-faint">
          Full breakdown, updated as it actually changes, in{' '}
          <a href={`${README_URL}`} className="underline underline-offset-2 hover:text-text-soft">
            README.md's "What exists today"
          </a>
          .
        </p>
      </Container>
    </section>
  );
}
