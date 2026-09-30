import type { PipenzoRunBudgetV1 } from '@agent-dock/shared';
import type { SelectOption } from '../components/primitives/Select.js';

/**
 * The workspace default run budget's option labels (`Settings.dc.html`'s "Workspace default run
 * budget" `<select>`), for `ConcurrencyPanel`'s `Select`. Kept as a fixed, ordered list rather than
 * derived from the schema's enum values directly -- the enum's own member names
 * (`cap_200k_tokens`) are wire identifiers, not copy, and this is the one place that translates
 * between the two.
 */
export const RUN_BUDGET_OPTIONS: readonly SelectOption[] = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'one_run', label: '1 run' },
  { value: 'three_runs', label: '3 runs' },
  { value: 'cap_200k_tokens', label: 'Cap at 200k tokens' },
];

/** Type guard for the `<select>`'s native `onChange`, whose `event.target.value` is a bare
 *  `string` -- narrows it back to `PipenzoRunBudgetV1` before it reaches the bridge, which parses
 *  the wire shape again on its own but should never be handed a value this file already knows is
 *  not one of the four options it just rendered. */
export function isPipenzoRunBudget(value: string): value is PipenzoRunBudgetV1 {
  return RUN_BUDGET_OPTIONS.some((option) => option.value === value);
}
