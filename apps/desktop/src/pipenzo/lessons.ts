import type { PipenzoLessonV1 } from '@agent-dock/shared';

/**
 * The date half of a saved lesson's meta line (`Settings.dc.html`'s own example: `jortega0033/
 * agentdock · saved from #94 · 6 Sep 14:14`). Same formatter `account.ts`'s `storedOnLabel` uses,
 * for the same reason: a fixed `en-GB`/UTC rendering so two machines in different locales or time
 * zones read a saved-at date identically rather than each formatting it their own way.
 */
export function lessonSavedOnLabel(savedAt: string): string | undefined {
  const at = new Date(savedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * The `.li-meta` line Settings' lesson row renders: `repo · saved from #N[ · date]`. The date is
 * dropped rather than shown as "invalid date" for a `savedAt` this build cannot parse -- the repo
 * and the issue number are still worth showing, and a malformed date is the daemon's problem, not
 * a reason to hide the rest of the row.
 */
export function lessonMetaLabel(
  lesson: Pick<PipenzoLessonV1, 'repo' | 'issueNumber' | 'savedAt'>,
): string {
  const savedOn = lessonSavedOnLabel(lesson.savedAt);
  const parts = [lesson.repo, `saved from #${lesson.issueNumber}`];
  if (savedOn !== undefined) parts.push(savedOn);
  return parts.join(' · ');
}
