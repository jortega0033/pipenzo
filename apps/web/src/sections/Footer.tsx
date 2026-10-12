import lockup from '../assets/pipenzo/brand/pipenzo-lockup-horizontal-dark.svg';
import { Container } from '../components/Container.js';
import { REPO_URL } from '../content.js';

const LINKS = [
  { label: 'GitHub', href: REPO_URL },
  { label: 'README', href: `${REPO_URL}#readme` },
  { label: 'Security', href: `${REPO_URL}/blob/main/SECURITY.md` },
  { label: 'Contributing', href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
  { label: 'License', href: `${REPO_URL}/blob/main/LICENSE` },
] as const;

export function Footer() {
  return (
    <footer className="py-12">
      <Container className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <img
          src={lockup}
          alt="Pipenzo"
          width={196}
          height={48}
          loading="lazy"
          className="h-9 w-auto"
        />
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-soft">
            {LINKS.map((link) => (
              <li key={link.label}>
                <a href={link.href} className="underline-offset-2 hover:text-text hover:underline">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <Container className="mt-8">
        <p className="font-mono text-xs text-text-faint">Apache-2.0 · built in the open</p>
      </Container>
    </footer>
  );
}
