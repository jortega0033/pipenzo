/**
 * Input contract for read-only candidate reconciliation (Pipenzo #358, slice 1a): the types the
 * reconciler reads and returns, and the bounds enforced before scoring. Bad input is rejected with
 * a typed error, never guessed at. Scoring lives in `candidate-reconciler.ts`.
 */

export type ReconcileProvenanceKind = 'note' | 'url' | 'issue' | 'other';

/** Where the idea came from. Untrusted text shown to the human, never an instruction. */
export interface ReconcileProvenance {
  readonly kind: ReconcileProvenanceKind;
  readonly ref: string;
}

export interface ReconcileCandidate {
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly provenance: ReconcileProvenance;
}

/** The subset of a GitHub issue the reconciler reads. Bodies are scored, never echoed. */
export interface ReconcileIssue {
  readonly number: number;
  readonly title: string;
  /** GitHub returns null for an empty body; it is normalised to ''. */
  readonly body: string | null;
  readonly state: 'open' | 'closed';
}

/** A validated copy of an issue: the body is always a string. */
export type NormalizedIssue = ReconcileIssue & { readonly body: string };

export interface ReconcileSnapshot {
  readonly issues: readonly ReconcileIssue[];
  /** True when the caller could not list every issue; carried into the proposal. */
  readonly truncated: boolean;
}

export type ReconcileOutcome = 'no_match' | 'possible_duplicate' | 'existing_owner';

export interface ReconcileMatch {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly score: number;
  readonly reason: string;
}

export interface ReconcileProposal {
  readonly schemaVersion: 1;
  readonly outcome: ReconcileOutcome;
  readonly matches: readonly ReconcileMatch[];
  readonly provenance: ReconcileProvenance;
  readonly examined: number;
  readonly snapshotTruncated: boolean;
}

export type ReconcileErrorCode = 'invalid_candidate' | 'invalid_snapshot';

export class ReconcileError extends Error {
  readonly code: ReconcileErrorCode;

  constructor(code: ReconcileErrorCode, message: string) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
  }
}

export const MAX_TITLE_CHARS = 256;
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_CHARS = 1_000;
export const MAX_PROVENANCE_REF_CHARS = 300;
export const MAX_SNAPSHOT_ISSUES = 2_000;
export const MAX_ISSUE_TITLE_CHARS = 300;

export function validateCandidate(candidate: ReconcileCandidate): void {
  const bad = (message: string): never => {
    throw new ReconcileError('invalid_candidate', message);
  };
  if (!candidate || typeof candidate !== 'object') bad('candidate is missing');
  if (typeof candidate.title !== 'string' || !candidate.title.trim())
    bad('candidate needs a title');
  if (candidate.title.length > MAX_TITLE_CHARS) bad('candidate title is too long');
  if (
    !Array.isArray(candidate.acceptanceCriteria) ||
    candidate.acceptanceCriteria.length > MAX_CRITERIA
  ) {
    bad('candidate has too many acceptance criteria');
  }
  for (const criterion of candidate.acceptanceCriteria) {
    if (typeof criterion !== 'string' || criterion.length > MAX_CRITERION_CHARS)
      bad('an acceptance criterion is invalid or too long');
  }
  const { provenance } = candidate;
  if (!provenance || !['note', 'url', 'issue', 'other'].includes(provenance.kind))
    bad('candidate provenance kind is invalid');
  if (
    typeof provenance.ref !== 'string' ||
    !provenance.ref.trim() ||
    provenance.ref.length > MAX_PROVENANCE_REF_CHARS
  ) {
    bad('candidate provenance ref is missing or too long');
  }
}

/** Validates every issue and returns normalised copies: callers score these, not the input. */
export function validateSnapshot(snapshot: ReconcileSnapshot): NormalizedIssue[] {
  const bad = (message: string): never => {
    throw new ReconcileError('invalid_snapshot', message);
  };
  if (!snapshot || !Array.isArray(snapshot.issues) || snapshot.issues.length > MAX_SNAPSHOT_ISSUES)
    bad('issue snapshot is missing or too large');
  if (typeof snapshot.truncated !== 'boolean') bad('issue snapshot needs a truncated flag');
  const seen = new Set<number>();
  const issues: NormalizedIssue[] = [];
  for (const issue of snapshot.issues) {
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1)
      bad('an issue number is invalid');
    if (typeof issue.title !== 'string') bad('an issue title is invalid');
    if (issue.body !== null && typeof issue.body !== 'string') bad('an issue body is invalid');
    if (issue.state !== 'open' && issue.state !== 'closed') bad('an issue state is invalid');
    if (seen.has(issue.number)) continue; // pagination overlap: keep the first copy
    seen.add(issue.number);
    issues.push({
      number: issue.number,
      title: issue.title.slice(0, MAX_ISSUE_TITLE_CHARS),
      body: issue.body ?? '',
      state: issue.state,
    });
  }
  return issues;
}
