import { Container } from '../components/Container.js';
import { README_URL, REPO_URL } from '../content.js';
import { GitHubMark } from './SiteNav.js';

export function ClosingCta() {
  return (
    <section aria-labelledby="closing-heading" className="relative overflow-hidden py-24 sm:py-28">
      <div
        className="glow-accent pointer-events-none absolute left-1/2 top-1/2 h-[28rem] w-[46rem] -translate-x-1/2 -translate-y-1/2"
        aria-hidden="true"
      />
      <Container className="relative text-center">
        <h2
          id="closing-heading"
          className="mx-auto max-w-2xl text-3xl font-bold leading-tight tracking-tight text-text sm:text-5xl"
        >
          Follow the build on GitHub
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-text-soft">
          The pipeline is landing piece by piece, in public. The README's status list is the source
          of truth for what runs today.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href={REPO_URL}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-bold text-accent-fg transition hover:brightness-110 active:scale-[0.98]"
          >
            <GitHubMark className="h-4 w-4" />
            Open the repository
          </a>
          <a
            href={README_URL}
            className="inline-flex items-center gap-2 rounded-full border border-surface-4 px-6 py-3 font-bold text-text transition hover:border-text-faint hover:bg-surface-2"
          >
            Read the README
          </a>
        </div>
      </Container>
    </section>
  );
}
