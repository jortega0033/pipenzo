/**
 * The pill-shaped multi-way switch from Foundations.dc.html: Simple/Expert, the ticket
 * switcher, Connect's step bar, Activity's filter tabs all share this one visual treatment.
 * This component covers the toggle-button-group case (Simple/Expert, filter tabs) -- each
 * option is a real <button> with aria-pressed reflecting selection, and the whole group carries
 * `aria-label` since it has no visible group label of its own in the canvas.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'active' : undefined}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
