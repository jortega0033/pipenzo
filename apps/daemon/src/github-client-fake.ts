import {
  GitHubClientError,
  type GitHubCheckRun,
  type GitHubClient,
  type GitHubIssue,
  type GitHubIssueDraft,
  type GitHubLabel,
  type GitHubPullRequestDiff,
  type RepoRef,
} from './github-client.js';

/**
 * In-memory `GitHubClient` (issue #177, README's Testing suite 2).
 *
 * This lives in `src/` rather than `test/` on purpose, mirroring agentdock's own
 * `packages/agent-runtime/src/providers/fake/`: the polling reconciler, the label state machine
 * and the claim race (build step 3) are all tested from *their own* packages against this, so it
 * has to be importable, not a fixture private to one test file.
 *
 * It is also the first real proof that `GitHubClient` is an interface rather than a class with an
 * `interface` keyword in front of it — a second implementation that never touches the network.
 */
export class FakeGitHubClient implements GitHubClient {
  readonly #issues = new Map<string, GitHubIssue>();
  readonly #labels = new Map<string, GitHubLabel[]>();
  readonly #diffs = new Map<string, GitHubPullRequestDiff>();
  readonly #checks = new Map<string, GitHubCheckRun[]>();
  /** Every call, in order, so a test can assert *what was asked of GitHub*, not just the answer. */
  readonly calls: Array<{ method: string; key: string }> = [];
  /** Queued failure per method name, consumed once. Lets a test drive the error paths. */
  readonly #failures = new Map<string, GitHubClientError>();
  /** Where `createIssue` starts numbering. Seeded issues above it stay addressable. */
  #nextIssueNumber = 1_000;

  /** Pins the next number `createIssue` will hand out, so a test can assert an exact url. */
  setNextIssueNumber(next: number): this {
    this.#nextIssueNumber = next;
    return this;
  }

  static key(ref: RepoRef, suffix: string | number): string {
    return `${ref.owner}/${ref.repo}#${suffix}`;
  }

  seedIssue(issue: GitHubIssue): this {
    this.#issues.set(FakeGitHubClient.key(issue, issue.number), issue);
    return this;
  }

  seedLabels(ref: RepoRef, labels: readonly GitHubLabel[]): this {
    this.#labels.set(`${ref.owner}/${ref.repo}`, [...labels]);
    return this;
  }

  seedPullRequestDiff(ref: RepoRef, diff: GitHubPullRequestDiff): this {
    this.#diffs.set(FakeGitHubClient.key(ref, diff.number), diff);
    return this;
  }

  seedChecks(ref: RepoRef, pullNumber: number, runs: readonly GitHubCheckRun[]): this {
    this.#checks.set(FakeGitHubClient.key(ref, pullNumber), [...runs]);
    return this;
  }

  failNext(method: keyof GitHubClient, error: GitHubClientError): this {
    this.#failures.set(method, error);
    return this;
  }

  #enter(method: keyof GitHubClient, key: string): void {
    this.calls.push({ method, key });
    const failure = this.#failures.get(method);
    if (failure) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<GitHubIssue> {
    const key = FakeGitHubClient.key(ref, issueNumber);
    this.#enter('getIssue', key);
    const issue = this.#issues.get(key);
    if (!issue) throw new GitHubClientError('not_found', `getIssue ${key}: no such issue`);
    return issue;
  }

  async listLabels(ref: RepoRef): Promise<readonly GitHubLabel[]> {
    const key = `${ref.owner}/${ref.repo}`;
    this.#enter('listLabels', key);
    return [...(this.#labels.get(key) ?? [])];
  }

  async createLabel(ref: RepoRef, label: GitHubLabel): Promise<GitHubLabel> {
    const key = `${ref.owner}/${ref.repo}`;
    this.#enter('createLabel', `${key}:${label.name}`);
    const existing = this.#labels.get(key) ?? [];
    const found = existing.find((candidate) => candidate.name === label.name);
    // Matches the real client: creating a label that already exists is success, not a conflict.
    if (found) return found;
    existing.push(label);
    this.#labels.set(key, existing);
    return label;
  }

  /**
   * Adds an assignee, exactly as GitHub's `POST .../assignees` does: additively, and without
   * refusing when somebody else is already there.
   *
   * That last part is what makes this fake useful for the claim race (issue #83). A fake that
   * threw on a second assignee would let a test pass while the real client happily succeeded and
   * the caller never re-read the issue — the *re-read* is where the refusal comes from, and this
   * fake exists to keep that testable rather than to pre-empt it.
   */
  async assignIssue(ref: RepoRef, issueNumber: number, assignee: string): Promise<GitHubIssue> {
    const key = FakeGitHubClient.key(ref, issueNumber);
    this.#enter('assignIssue', `${key}:${assignee}`);
    const issue = this.#issues.get(key);
    if (!issue) throw new GitHubClientError('not_found', `assignIssue ${key}: no such issue`);
    if (issue.assignees.includes(assignee)) return issue;
    const updated: GitHubIssue = { ...issue, assignees: [...issue.assignees, assignee] };
    this.#issues.set(key, updated);
    return updated;
  }

  async createIssue(ref: RepoRef, input: GitHubIssueDraft): Promise<GitHubIssue> {
    const repoKey = `${ref.owner}/${ref.repo}`;
    this.#enter('createIssue', `${repoKey}:${input.title}`);
    const number = this.#nextIssueNumber;
    this.#nextIssueNumber += 1;
    const issue: GitHubIssue = {
      owner: ref.owner,
      repo: ref.repo,
      number,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      assignees: [],
      htmlUrl: `https://github.com/${repoKey}/issues/${number}`,
      updatedAt: new Date(0).toISOString(),
      etag: undefined,
    };
    this.#issues.set(FakeGitHubClient.key(ref, number), issue);
    return issue;
  }

  async getPullRequestDiff(ref: RepoRef, pullNumber: number): Promise<GitHubPullRequestDiff> {
    const key = FakeGitHubClient.key(ref, pullNumber);
    this.#enter('getPullRequestDiff', key);
    const diff = this.#diffs.get(key);
    if (!diff) throw new GitHubClientError('not_found', `getPullRequestDiff ${key}: no such pull request`);
    return diff;
  }

  async listPullRequestChecks(
    ref: RepoRef,
    pullNumber: number,
  ): Promise<readonly GitHubCheckRun[]> {
    const key = FakeGitHubClient.key(ref, pullNumber);
    this.#enter('listPullRequestChecks', key);
    return [...(this.#checks.get(key) ?? [])];
  }
}
