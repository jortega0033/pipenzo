import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';
import { REPO_URL, RESEARCH_REPORT_URL } from '../content.js';

const FACTS = [
  { label: 'license', value: 'Apache-2.0' },
  { label: 'desktop_shell', value: 'Electron, with a local daemon' },
  { label: 'coding_models', value: 'Claude Code / Codex through your own authentication' },
  {
    label: 'proprietary_model',
    value: 'None. Pipenzo brings no models or inference credits of its own',
  },
] as const;

export function OpenSource() {
  return (
    <section
      aria-labelledby="open-source-heading"
      className="border-b border-border py-24 sm:py-28"
    >
      <Container className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div>
          <SectionHeading
            index="07"
            label="open source"
            id="open-source-heading"
            title="Open source, local-first"
          >
            <p>
              Pipenzo has no hosted sandbox and sends you no inference bill. It runs on{' '}
              <a
                href="https://github.com/jortega0033/agentdock"
                className="text-text underline underline-offset-2 hover:text-accent"
              >
                agentdock
              </a>
              , which drives the Claude Code and Codex CLIs as local subprocesses under your own
              authentication, on your own machine.
            </p>
          </SectionHeading>
          <p className="mt-8 text-sm leading-relaxed text-text-faint">
            The full landscape, stack rationale, and competitive positioning against Devin, Copilot,
            Cursor, OpenHands, Kiro, Jules, Codegen, and Graphite lives in the{' '}
            <a
              href={RESEARCH_REPORT_URL}
              className="text-text-soft underline underline-offset-2 hover:text-text"
            >
              research report
            </a>
            . There's no monetization plan here. It's a portfolio and open-source project, plain and
            simple.
          </p>
        </div>

        <div className="self-center overflow-hidden rounded-pipenzo border border-border bg-surface shadow-elevated">
          <p
            className="border-b border-border px-5 py-3 font-mono text-xs text-text-faint"
            aria-hidden="true"
          >
            pipenzo / facts
          </p>
          <dl className="divide-y divide-border">
            {FACTS.map((fact) => (
              <div
                key={fact.label}
                className="grid gap-1 px-5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-4"
              >
                <dt className="font-mono text-xs leading-6 text-accent">{fact.label}</dt>
                <dd className="text-text">{fact.value}</dd>
              </div>
            ))}
          </dl>
          <a
            href={REPO_URL}
            className="flex items-center justify-between border-t border-border px-5 py-4 text-sm font-semibold text-text transition-colors hover:bg-surface-2"
          >
            Read the code
            <span aria-hidden="true" className="text-accent">
              →
            </span>
          </a>
        </div>
      </Container>
    </section>
  );
}
