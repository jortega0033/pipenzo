/**
 * The screenshot-capture child process, as a fixed string (Pipenzo issue #139).
 *
 * ## Why a string, and why a child process
 *
 * README requires that the daemon own every Playwright call and that **no agent-generated
 * JavaScript ever runs inside the daemon**, because the daemon is the process holding the token
 * vault. But README also requires Pipenzo to use *the repository's own* Playwright rather than
 * shipping a browser — and the repository's `node_modules` is code a human committed, not code the
 * daemon reviewed. Importing it into the daemon process would put repo-supplied code next to the
 * PAT, which is the same hazard `pipenzo-git.ts` documents at length for `post-checkout` hooks and
 * `core.fsmonitor`.
 *
 * So the two requirements are met separately:
 *
 * - **This source is fixed and daemon-authored.** Not a template. The job — origin, resolved URLs,
 *   selectors, viewports, output paths — arrives on **stdin as JSON** and is never interpolated
 *   into this text. `capture-runner-source.test.ts` asserts that: the string contains no `${`, and
 *   the executor never concatenates a manifest value into it. An agent's manifest is therefore
 *   *data this program reads*, in exactly the way a JSON config file is, and there is no path by
 *   which it becomes a program.
 * - **It runs as a child process on the reviewed environment floor.** The executor spawns it with
 *   `buildGitEnvironment()`, which carries no `PIPENZO_GITHUB_TOKEN` and no `AGENT_DOCK_*`
 *   variable. So the repository's Playwright — and anything Playwright loads — runs without the
 *   credential and without a handle back into the daemon.
 *
 * ## The origin confinement, done twice
 *
 * `resolveCaptureUrl()` already proved every destination is on the daemon's own dev-server origin
 * before this program was spawned. This program then refuses to let the *page* leave it either:
 * every request the page makes is intercepted and aborted unless its origin matches, and a frame
 * that navigates off-origin fails the capture rather than being photographed. A dev server that
 * pulls a font from a CDN therefore renders without it, deterministically and offline, which is
 * the right trade for evidence that has to mean the same thing twice.
 */
export const CAPTURE_RUNNER_SOURCE = `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) reject(new Error('capture job payload too large'));
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function sameOrigin(candidate, origin) {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

async function main() {
  const job = JSON.parse(await readStdin());
  const require = createRequire(job.requireFrom);
  const specifier = pathToFileURL(require.resolve(job.packageName)).href;
  const loaded = await import(specifier);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium) throw new Error('the repository Playwright exposes no chromium launcher');

  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const capture of job.captures) {
      const started = Date.now();
      let context;
      try {
        context = await browser.newContext({
          viewport: { width: capture.viewport.width, height: capture.viewport.height },
          deviceScaleFactor: capture.viewport.deviceScaleFactor ?? 1,
          // No stored state of any kind: two runs of the same manifest must produce the same
          // picture, and a cookie carried between them is a reason they would not.
          storageState: undefined,
        });
        // Every request, not just navigations. The capture is confined to the origin the daemon
        // started; anything else is aborted rather than fetched.
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith('data:') || url.startsWith('about:') || sameOrigin(url, job.origin)) {
            return route.continue();
          }
          return route.abort();
        });
        const page = await context.newPage();
        let offOrigin = null;
        page.on('framenavigated', (frame) => {
          const url = frame.url();
          if (url === 'about:blank' || url === '') return;
          if (!sameOrigin(url, job.origin)) offOrigin = url;
        });

        await page.goto(capture.url, { waitUntil: 'domcontentloaded', timeout: job.stepTimeoutMs });
        await page.waitForSelector(capture.waitForSelector, {
          state: 'visible',
          timeout: job.stepTimeoutMs,
        });
        for (const action of capture.actions) {
          if (action.type === 'click') {
            await page.click(action.selector, { timeout: job.stepTimeoutMs });
          } else if (action.type === 'fill') {
            await page.fill(action.selector, action.value, { timeout: job.stepTimeoutMs });
          } else {
            throw new Error('unsupported capture action');
          }
        }
        // Re-synchronise after the actions so the screenshot is taken against the same anchor the
        // capture named, not against whatever the last click left mid-transition.
        await page.waitForSelector(capture.waitForSelector, {
          state: 'visible',
          timeout: job.stepTimeoutMs,
        });
        if (offOrigin) throw new Error('the page navigated off the dev-server origin');
        await page.screenshot({ path: capture.outputPath, fullPage: false, animations: 'disabled' });
        results.push({
          name: capture.name,
          status: 'captured',
          outputPath: capture.outputPath,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        results.push({
          name: capture.name,
          status: 'failed',
          reason: String(error && error.message ? error.message : error).slice(0, 1000),
          durationMs: Date.now() - started,
        });
      } finally {
        if (context) await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  process.stdout.write(JSON.stringify({ ok: true, results }));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      reason: String(error && error.message ? error.message : error).slice(0, 1000),
    }),
  );
  process.exitCode = 1;
});
`;
