/**
 * Read-only candidate reconciliation (Pipenzo #358, slice 1b: the scorer). A pure function: given a
 * drafted candidate and an issue snapshot it names the closest existing owner or duplicate. No
 * model, network, GitHub client or write; filing stays the human-clicked `createIssue`. The score
 * is a plain token overlap so a human can read the reason and check it.
 */

import {
  ReconcileError,
  validateCandidate,
  validateSnapshot,
  type ReconcileCandidate,
  type ReconcileMatch,
  type ReconcileOutcome,
  type ReconcileProposal,
  type ReconcileSnapshot,
} from './reconcile-input.js';

export const MAX_MATCHES = 3;
export const OWNER_THRESHOLD = 0.6;
export const POSSIBLE_THRESHOLD = 0.35;
const MAX_REASON_TOKENS = 8;
const BODY_WEIGHT = 0.75;
const MIN_TOKENS_FOR_BODY_MATCH = 4;
/** Bodies are scored on their first slice only, so one huge issue cannot dominate the cost. */
const MAX_BODY_SCORED_CHARS = 20_000;

const STOPWORDS = new Set(
  'the and for with that this from when then into are not has have any all can will shall should must its add use'.split(
    ' ',
  ),
);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const token = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (token.length >= 3 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((token) => b.has(token));
}

export function reconcileCandidate(
  candidate: ReconcileCandidate,
  snapshot: ReconcileSnapshot,
): ReconcileProposal {
  validateCandidate(candidate);
  const issues = validateSnapshot(snapshot);
  const titleTokens = tokenize(candidate.title);
  if (titleTokens.size === 0) {
    throw new ReconcileError('invalid_candidate', 'candidate title has no searchable words');
  }
  const allTokens = tokenize([candidate.title, ...candidate.acceptanceCriteria].join(' '));

  const scored: (ReconcileMatch & { words: string[] })[] = [];
  for (const issue of issues) {
    const issueTitle = tokenize(issue.title);
    const titleShared = shared(titleTokens, issueTitle);
    let score = (2 * titleShared.length) / (titleTokens.size + issueTitle.size || 1);
    let words = titleShared;
    // The body path needs at least one title word in the issue title, so a long generic body
    // cannot outrank or replace a real title match.
    if (titleShared.length > 0 && allTokens.size >= MIN_TOKENS_FOR_BODY_MATCH) {
      const issueAll = tokenize(`${issue.title} ${issue.body.slice(0, MAX_BODY_SCORED_CHARS)}`);
      const allShared = shared(allTokens, issueAll);
      const coverage = (allShared.length / allTokens.size) * BODY_WEIGHT;
      if (coverage > score) {
        score = coverage;
        words = allShared;
      }
    }
    const rounded = Math.round(score * 100) / 100;
    if (rounded < POSSIBLE_THRESHOLD) continue;
    scored.push({ number: issue.number, state: issue.state, score: rounded, reason: '', words });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1) ||
      a.number - b.number,
  );
  const matches: ReconcileMatch[] = scored.slice(0, MAX_MATCHES).map(({ words, ...match }) => ({
    ...match,
    reason: `shared words: ${[...words].sort().slice(0, MAX_REASON_TOKENS).join(', ')}; overlap score ${match.score}`,
  }));
  const top = scored[0];
  // One shared word is never enough to call something the owner.
  const outcome: ReconcileOutcome = !top
    ? 'no_match'
    : top.score >= OWNER_THRESHOLD && top.words.length >= 2
      ? 'existing_owner'
      : 'possible_duplicate';

  return {
    schemaVersion: 1,
    outcome,
    matches,
    provenance: { kind: candidate.provenance.kind, ref: candidate.provenance.ref },
    examined: issues.length,
    snapshotTruncated: snapshot.truncated,
  };
}
