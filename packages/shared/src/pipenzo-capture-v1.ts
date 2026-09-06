import { z } from 'zod';

/**
 * The screenshot-verification capture manifest (Pipenzo issue #138).
 *
 * README states the property this schema exists to make true, and it is a security property, not
 * a style choice:
 *
 * > The agent never writes automation code that the daemon then executes. It proposes a
 * > **manifest** — `{route, viewport, waitForSelector, actions: [{click|fill, selector, value}]}` —
 * > which is validated against a schema; the daemon owns every actual Playwright call [...] **No
 * > agent-generated JavaScript ever runs inside the daemon**, which is the process holding the
 * > token vault.
 *
 * So the shape below is not a convenience wrapper around a script — it is a closed, finite
 * vocabulary. There are exactly two actions. There is no `evaluate`, no `waitForFunction`, no
 * `addInitScript`, no `route` interception, no `expression`, no `script`, and no free-text field
 * whose contents reach a JavaScript engine. Adding one would hand an agent code execution beside
 * the credential, which is the single thing this design cannot survive.
 *
 * ## Why the strings are validated this hard
 *
 * A "declarative manifest" that carries an arbitrary string into a Playwright call is only
 * declarative until someone notices what those strings can be. Two of them can reach further than
 * they look:
 *
 * - **`route`** is joined onto the ephemeral localhost origin the daemon started. A scheme, an
 *   authority, or a protocol-relative `//host` would take the capture off that origin entirely.
 *   `captureRouteV1Schema` refuses all three, and the daemon re-checks the *resolved* origin after
 *   joining rather than trusting this schema to have been sufficient.
 * - **`selector`** reaches Playwright's selector parser, which is not CSS-only: `text=`, `xpath=`
 *   and `css=` are engine prefixes, `>>` chains one engine into another, and a repository can
 *   register custom engines. `captureSelectorV1Schema` allows a CSS-shaped subset and refuses
 *   every engine prefix, every chain, and every character an XPath needs — so what arrives is a
 *   selector, not a small language.
 *
 * Neither of those is a claim that Playwright would execute a selector as code. They are the
 * narrower claim worth making: the manifest addresses elements on one page on one origin, and
 * nothing in it selects a different engine, a different origin, or a different document.
 */

const noControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });

/**
 * A path on the daemon's own ephemeral origin.
 *
 * Absolute-with-leading-slash only. `//host/x` is rejected explicitly and separately from the
 * leading-slash rule, because it *has* a leading slash and resolves to another authority — the
 * one shape that passes a naive "must start with /" check and still leaves the origin.
 */
export const captureRouteV1Schema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.startsWith('/'), 'must be a path on the app’s own origin')
  .refine((value) => !value.startsWith('//'), 'must not be protocol-relative')
  .refine(noControlCharacters, 'must not contain control characters')
  .refine((value) => !value.includes('\\'), 'must use forward slashes')
  .refine((value) => !/^\/*[A-Za-z][A-Za-z0-9+.-]*:/.test(value), 'must not carry a URL scheme')
  .refine(
    (value) => !value.split(/[/?#]/).includes('..'),
    'must not traverse upward out of the app',
  )
  .refine(
    (value) => /^[A-Za-z0-9._~!$&'()*+,;=:@/%?#-]+$/.test(value),
    'must be a URL-safe path',
  );

/** Playwright engine prefixes: `text=`, `xpath=`, `css=`, `id=`, and anything else shaped so. */
const ENGINE_PREFIX = /^\s*[A-Za-z][A-Za-z0-9_-]*\s*=/;

/**
 * A CSS-shaped selector, and only that.
 *
 * The character allowlist is what does the work: it has no `/` (so no XPath), no `\` (so no CSS
 * escape sequences smuggling a byte past the allowlist), and no `{};<` (so nothing that reads as a
 * rule block or a tag). The two explicit refusals on top of it name the two things a valid-looking
 * CSS string can still be — an engine prefix and an engine chain.
 */
export const captureSelectorV1Schema = z
  .string()
  .min(1)
  .max(512)
  .refine(noControlCharacters, 'must not contain control characters')
  .refine(
    (value) => /^[A-Za-z0-9 _\-.#[\]="':(),>+~*^$|]+$/.test(value),
    'must be a plain CSS selector',
  )
  .refine((value) => !ENGINE_PREFIX.test(value), 'must not select a Playwright selector engine')
  .refine((value) => !value.includes('>>'), 'must not chain selector engines');

/**
 * The viewport. Bounded on both ends: a 1x1 viewport produces a useless screenshot and an
 * unbounded one is a memory allocation an agent gets to choose the size of.
 */
export const captureViewportV1Schema = z
  .object({
    width: z.number().int().min(320).max(3_840),
    height: z.number().int().min(240).max(2_160),
    /** Integer only — a fractional scale is a rendering difference nobody asked the agent for. */
    deviceScaleFactor: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

/**
 * The complete action vocabulary. Two entries, and that is the whole language.
 *
 * `click` and `fill` are what README names, and neither takes anything a JavaScript engine sees:
 * a click carries a selector, a fill carries a selector and a literal string that Playwright types
 * into an input. There is deliberately no `press` (which takes key expressions), no `select`
 * (which would need option matching semantics), and no `evaluate` of any kind.
 */
export const captureActionV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: captureSelectorV1Schema }).strict(),
  z
    .object({
      type: z.literal('fill'),
      selector: captureSelectorV1Schema,
      value: z
        .string()
        .max(1_000)
        .refine(noControlCharacters, 'must not contain control characters'),
    })
    .strict(),
]);

/** A stable, filesystem-safe name for one shot, so evidence can be paired before/after by name. */
export const captureNameV1Schema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'must be a lowercase kebab-case name');

export const captureManifestV1Schema = z
  .object({
    name: captureNameV1Schema,
    route: captureRouteV1Schema,
    viewport: captureViewportV1Schema,
    /**
     * Required, not optional. A capture with no synchronisation point screenshots whatever
     * happened to be painted, which produces a before/after pair that differs for reasons nobody
     * can attribute to the diff — the exact failure mode that makes screenshot evidence worthless.
     */
    waitForSelector: captureSelectorV1Schema,
    actions: z.array(captureActionV1Schema).max(20),
  })
  .strict();

/**
 * The set the agent proposes for one ticket.
 *
 * Capped low on purpose: each capture is a page load and two screenshots (before and after), and
 * the whole step already takes the execution slot serially. Ten is generous for evidence and
 * cheap enough that a manifest cannot become a workload.
 */
export const captureManifestSetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captures: z.array(captureManifestV1Schema).min(1).max(10),
  })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const [index, capture] of set.captures.entries()) {
      if (seen.has(capture.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['captures', index, 'name'],
          message: 'capture names must be unique within a manifest',
        });
      }
      seen.add(capture.name);
    }
  });

export type CaptureViewportV1 = z.infer<typeof captureViewportV1Schema>;
export type CaptureActionV1 = z.infer<typeof captureActionV1Schema>;
export type CaptureManifestV1 = z.infer<typeof captureManifestV1Schema>;
export type CaptureManifestSetV1 = z.infer<typeof captureManifestSetV1Schema>;

/**
 * The same contract as a JSON Schema, for the structured-output capability the proposing agent
 * runs under — mirroring `REFINE_SPEC_V1_JSON_SCHEMA`'s reasoning.
 *
 * The provider sees this one; the daemon re-validates with the Zod schema above, because a
 * provider's structured-output guarantee is not a thing to take on trust at the boundary where the
 * next step is driving a browser. Note that the JSON Schema is deliberately *looser* than the Zod
 * one on the two dangerous strings: JSON Schema `pattern` is not the place to express the engine
 * and origin rules, and expressing them weakly there would invite the belief that they had been
 * checked already.
 */
export const CAPTURE_MANIFEST_SET_V1_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'captures'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    captures: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'route', 'viewport', 'waitForSelector', 'actions'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
          route: { type: 'string', minLength: 1, maxLength: 2048 },
          viewport: {
            type: 'object',
            additionalProperties: false,
            required: ['width', 'height'],
            properties: {
              width: { type: 'integer', minimum: 320, maximum: 3840 },
              height: { type: 'integer', minimum: 240, maximum: 2160 },
              deviceScaleFactor: { type: 'integer', enum: [1, 2] },
            },
          },
          waitForSelector: { type: 'string', minLength: 1, maxLength: 512 },
          actions: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'selector'],
              properties: {
                type: { type: 'string', enum: ['click', 'fill'] },
                selector: { type: 'string', minLength: 1, maxLength: 512 },
                value: { type: 'string', maxLength: 1000 },
              },
            },
          },
        },
      },
    },
  },
} as const);
