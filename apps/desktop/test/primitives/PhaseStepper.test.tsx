import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhaseStepper, type StepSpec } from '../../src/components/primitives/PhaseStepper.js';

const baseSteps: StepSpec[] = [
  { id: 'refine', label: 'Refine', status: 'done', number: 1 },
  { id: 'plan-review', label: 'Plan review', status: 'done', number: 2 },
  { id: 'implement', label: 'Implement', status: 'active', number: 3 },
  { id: 'review', label: 'Review', status: 'upcoming', number: 4 },
  { id: 'publish', label: 'Publish', status: 'upcoming', number: 5 },
];

describe('PhaseStepper', () => {
  it('renders one button per step, in order, with its label', () => {
    render(<PhaseStepper steps={baseSteps} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => b.textContent?.trim().replace(/^\d*/, ''))).toEqual([
      'Refine',
      'Plan review',
      'Implement',
      'Review',
      'Publish',
    ]);
  });

  it('applies the matching modifier class per status, and no class for upcoming', () => {
    const { container } = render(<PhaseStepper steps={baseSteps} />);
    const steps = container.querySelectorAll('.step');
    expect(steps[0]!.className).toBe('step done');
    expect(steps[2]!.className).toBe('step active');
    expect(steps[3]!.className).toBe('step');
  });

  it('shows a check icon for done, the number for active/upcoming', () => {
    const { container } = render(<PhaseStepper steps={baseSteps} />);
    const stepNs = container.querySelectorAll('.step-n');
    expect(stepNs[0]!.querySelector('svg')).toBeInTheDocument();
    expect(stepNs[2]!.textContent).toBe('3');
    expect(stepNs[3]!.textContent).toBe('4');
  });

  it('shows a bell icon for await and pulses via the await modifier class', () => {
    const steps: StepSpec[] = [
      { id: 'refine', label: 'Refine', status: 'done', number: 1 },
      { id: 'plan-review', label: 'Plan review', status: 'await', number: 2 },
    ];
    const { container } = render(<PhaseStepper steps={steps} />);
    const awaitStep = container.querySelectorAll('.step')[1]!;
    expect(awaitStep.className).toBe('step await');
    expect(awaitStep.querySelector('.step-n svg')).toBeInTheDocument();
  });

  it('shows an x icon and grows a 5th CI step for a fail state', () => {
    const steps: StepSpec[] = [
      ...baseSteps.slice(0, 4).map((s) => ({ ...s, status: 'done' as const })),
      { id: 'ci', label: 'CI', status: 'fail', number: 5 },
    ];
    const { container } = render(<PhaseStepper steps={steps} />);
    expect(container.querySelectorAll('.step')).toHaveLength(5);
    const ciStep = container.querySelectorAll('.step')[4]!;
    expect(ciStep.className).toBe('step fail');
    expect(ciStep.querySelector('.step-n svg')).toBeInTheDocument();
  });

  it('calls onSelect with the clicked step id regardless of its status', () => {
    const onSelect = vi.fn();
    render(<PhaseStepper steps={baseSteps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Refine/ }));
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    expect(onSelect).toHaveBeenNthCalledWith(1, 'refine');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'publish');
  });

  it('renders a warn step-hint with a bell by default', () => {
    const { container } = render(
      <PhaseStepper steps={baseSteps} hint={{ text: 'awaiting input' }} />,
    );
    const hint = container.querySelector('.step-hint')!;
    expect(hint.className).toBe('step-hint');
    expect(hint.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('awaiting input')).toBeInTheDocument();
  });

  it('renders the quiet step-hint variant with no bell by default', () => {
    const { container } = render(
      <PhaseStepper steps={baseSteps} hint={{ text: 'ci-failed · fix ready', quiet: true }} />,
    );
    const hint = container.querySelector('.step-hint')!;
    expect(hint.className).toBe('step-hint quiet');
    expect(hint.querySelector('svg')).not.toBeInTheDocument();
  });

  it('omits the hint entirely when none is given', () => {
    const { container } = render(<PhaseStepper steps={baseSteps} />);
    expect(container.querySelector('.step-hint')).not.toBeInTheDocument();
  });
});
