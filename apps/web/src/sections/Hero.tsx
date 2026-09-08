import fieldEngineer from '../assets/pipenzo/mascot/detailed/pipenzo-field-engineer-canonical-fullbody.webp';
import { Container } from '../components/Container.js';
import { REPO_URL, README_URL } from '../content.js';

export function Hero() {
  return (
    <header className="border-b border-border">
      <Container className="grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="font-mono text-sm tracking-wide text-accent">pipenzo</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-text sm:text-5xl">
            Pipenzo delegates engineering work without delegating authority.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-text-soft">
            Point Pipenzo at a GitHub issue and it hands you back a small, easy-to-review pull
            request: Refine, Implement, Review, then you approve. It never pushes or opens a PR
            without you saying so first. That's not a promise baked into a prompt, it's how the
            code is built.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a
              href={REPO_URL}
              className="rounded-full bg-accent px-6 py-3 font-bold text-accent-fg transition hover:brightness-110 active:scale-95"
            >
              View on GitHub
            </a>
            <a
              href="#how-it-works"
              className="rounded-full bg-surface-3 px-6 py-3 font-bold text-text transition hover:brightness-125"
            >
              How it works
            </a>
          </div>
          <p className="mt-8 text-sm text-text-faint">
            Early days, and actively being built. Check{' '}
            <a href={README_URL} className="underline underline-offset-2 hover:text-text-soft">
              the README
            </a>{' '}
            for exactly what's real today and what's still being wired in. No download yet either;
            we'd rather wait until there's a real release than point you at one that doesn't
            exist.
          </p>
        </div>
        <img
          src={fieldEngineer}
          alt="The Field Engineer, Pipenzo's canonical operator, holding a laptop"
          width={1536}
          height={1536}
          loading="eager"
          className="mx-auto w-full max-w-sm"
        />
      </Container>
    </header>
  );
}
