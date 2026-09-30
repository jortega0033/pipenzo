import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RailBlock } from '../../src/components/primitives/RailBlock.js';
import { TicketDetailScreen } from '../../src/pipenzo/TicketDetailScreen.js';

describe('TicketDetailScreen', () => {
  it('renders the id and title in the header', () => {
    render(<TicketDetailScreen ticketId="#94" title="Sanitize environment" />);
    const header = document.querySelector('.header')!;
    expect(header.querySelector('.h-id')).toHaveTextContent('#94');
    expect(header.querySelector('.h-title')).toHaveTextContent('Sanitize environment');
  });

  it('omits the step row entirely when neither the stepper nor the switcher is supplied', () => {
    const { container } = render(<TicketDetailScreen ticketId="#94" title="t" />);
    expect(container.querySelector('.step-row')).not.toBeInTheDocument();
  });

  it('renders the stepper and ticket switcher together inside one step row, in that order', () => {
    render(
      <TicketDetailScreen
        ticketId="#94"
        title="t"
        stepper={<span data-testid="stepper">stepper</span>}
        ticketSwitcher={<span data-testid="switcher">switcher</span>}
      />,
    );
    const stepRow = document.querySelector('.step-row')!;
    expect(stepRow).toBeInTheDocument();
    const children = Array.from(stepRow.children);
    expect(children[0]).toHaveAttribute('data-testid', 'stepper');
    expect(children[1]).toHaveAttribute('data-testid', 'switcher');
  });

  it('renders the run-controls slot only when supplied', () => {
    const { rerender } = render(<TicketDetailScreen ticketId="#94" title="t" />);
    expect(screen.queryByText('running')).not.toBeInTheDocument();

    rerender(
      <TicketDetailScreen ticketId="#94" title="t" runControls={<div>running</div>} />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('renders the centre stream content inside .stream', () => {
    render(
      <TicketDetailScreen ticketId="#94" title="t">
        <span>event one</span>
      </TicketDetailScreen>,
    );
    const stream = document.querySelector('.stream')!;
    expect(stream).toHaveTextContent('event one');
  });

  it('renders the lesson prompt slot after the stream children, only when supplied', () => {
    const { rerender } = render(
      <TicketDetailScreen ticketId="#94" title="t">
        <span>event one</span>
      </TicketDetailScreen>,
    );
    expect(screen.queryByTestId('lesson-prompt')).not.toBeInTheDocument();

    rerender(
      <TicketDetailScreen
        ticketId="#94"
        title="t"
        lessonPrompt={<div data-testid="lesson-prompt">Worth remembering?</div>}
      >
        <span>event one</span>
      </TicketDetailScreen>,
    );
    const stream = document.querySelector('.stream')!;
    const children = Array.from(stream.children);
    expect(children.at(-1)).toHaveAttribute('data-testid', 'lesson-prompt');
  });

  it('lays out the four rail blocks in TicketDetail.dc.html order: Status, Cumulative risk, Model routing, Subscription headroom', () => {
    render(
      <TicketDetailScreen
        ticketId="#94"
        title="t"
        statusBlock={<RailBlock label="Status">s</RailBlock>}
        riskBlock={<RailBlock label="Cumulative risk">r</RailBlock>}
        modelRoutingBlock={<RailBlock label="Model routing">m</RailBlock>}
        headroomBlock={<RailBlock label="Subscription headroom">h</RailBlock>}
      />,
    );
    const rail = document.querySelector('.rail')!;
    const labels = Array.from(rail.querySelectorAll('.rail-block .label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'Status',
      'Cumulative risk',
      'Model routing',
      'Subscription headroom',
    ]);
  });

  it('renders an empty rail when no rail blocks are supplied', () => {
    render(<TicketDetailScreen ticketId="#94" title="t" />);
    const rail = document.querySelector('.rail')!;
    expect(rail.querySelectorAll('.rail-block')).toHaveLength(0);
  });
});
