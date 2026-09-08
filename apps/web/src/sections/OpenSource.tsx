import { Container } from '../components/Container.js';
import { REPO_URL, RESEARCH_REPORT_URL } from '../content.js';

const FACTS = [
  { label: 'License', value: 'Apache-2.0' },
  { label: 'Desktop shell', value: 'Electron, with a local daemon' },
  { label: 'Coding models', value: "Claude Code / Codex through your own authentication" },
  { label: 'Proprietary model', value: 'None. Pipenzo brings no models or inference credits of its own' },
] as const;

export function OpenSource() {
  return (
    <section aria-labelledby="open-source-heading" className="border-b border-border py-20">
      <Container>
        <h2 id="open-source-heading" className="text-3xl font-bold text-text">
          Open source, local-first
        </h2>
        <p className="mt-4 max-w-2xl text-text-soft">
          No hosted sandbox, no Pipenzo inference bill. Pipenzo runs on{' '}
          <a
            href="https://github.com/jortega0033/agentdock"
            className="underline underline-offset-2 hover:text-text-soft"
          >
            agentdock
          </a>
          , which drives the Claude Code and Codex CLIs as local subprocesses under your own
          authentication, on your own machine.
        </p>
        <dl className="mt-10 grid gap-6 sm:grid-cols-2">
          {FACTS.map((fact) => (
            <div key={fact.label} className="rounded-pipenzo bg-surface p-4 shadow-elevated-sm">
              <dt className="font-mono text-xs uppercase tracking-wide text-text-faint">{fact.label}</dt>
              <dd className="mt-1 text-text">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-sm text-text-faint">
          The full landscape, stack rationale, and competitive positioning against Devin, Copilot,
          Cursor, OpenHands, Kiro, Jules, Codegen, and Graphite lives in the{' '}
          <a href={RESEARCH_REPORT_URL} className="underline underline-offset-2 hover:text-text-soft">
            research report
          </a>
          . There's no monetization plan here. It's a portfolio and open-source project, plain and
          simple.{' '}
          <a href={REPO_URL} className="underline underline-offset-2 hover:text-text-soft">
            Read the code
          </a>
          .
        </p>
      </Container>
    </section>
  );
}
