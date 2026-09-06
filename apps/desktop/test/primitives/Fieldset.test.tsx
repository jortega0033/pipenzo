import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Fieldset } from '../../src/components/primitives/Fieldset.js';
import { FormRow } from '../../src/components/primitives/FormRow.js';
import { Toggle } from '../../src/components/primitives/Toggle.js';

describe('Fieldset', () => {
  it('renders a label and its children', () => {
    render(
      <Fieldset label="Notifications">
        <div>a control</div>
      </Fieldset>,
    );
    expect(screen.getByText('Notifications')).toHaveClass('f-lbl');
    expect(screen.getByText('a control')).toBeInTheDocument();
  });

  it('renders without a label', () => {
    render(
      <Fieldset>
        <div>a control</div>
      </Fieldset>,
    );
    expect(screen.getByText('a control')).toBeInTheDocument();
  });
});

describe('FormRow', () => {
  it('renders a label-left/control-right row', () => {
    render(
      <FormRow label="Sound">
        <Toggle checked={false} onChange={() => {}} aria-label="Sound" />
      </FormRow>,
    );
    expect(screen.getByText('Sound')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});
