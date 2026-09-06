import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalCard,
  ApprovalP,
  RefCell,
  RefGrid,
  RLink,
  StackList,
  StackNote,
} from '../../src/components/primitives/ApprovalCard.js';
import { Chip } from '../../src/components/primitives/Chip.js';
import { StackRow } from '../../src/components/primitives/StackRow.js';

describe('ApprovalCard', () => {
  it('renders the default danger tone with title, sub and a paragraph', () => {
    const { container } = render(
      <ApprovalCard icon="x" title="Plan rejected — reason posted to #98" sub="the ticket stays in Needs human">
        <ApprovalP>Nothing was written, no worktree exists.</ApprovalP>
      </ApprovalCard>,
    );
    expect(container.querySelector('.approval-ic')?.className).toBe('approval-ic');
    expect(screen.getByText('Plan rejected — reason posted to #98')).toBeInTheDocument();
    expect(screen.getByText('the ticket stays in Needs human')).toBeInTheDocument();
    expect(screen.getByText('Nothing was written, no worktree exists.')).toBeInTheDocument();
  });

  it('applies the warn/quiet/ok tone classes', () => {
    const { container, rerender } = render(<ApprovalCard tone="warn" icon="git-branch" title="t" />);
    expect(container.querySelector('.approval-ic')?.className).toBe('approval-ic warn');
    rerender(<ApprovalCard tone="quiet" icon="x" title="t" />);
    expect(container.querySelector('.approval-ic')?.className).toBe('approval-ic quiet');
    rerender(<ApprovalCard tone="ok" icon="check" title="t" />);
    expect(container.querySelector('.approval-ic')?.className).toBe('approval-ic ok');
  });

  it('renders a trailing head chip', () => {
    render(
      <ApprovalCard icon="x" title="Declined at Refine" chip={<Chip tone="neutral">finished</Chip>} />,
    );
    expect(screen.getByText('finished')).toBeInTheDocument();
  });

  it('renders actions and applies the justify override', () => {
    const { container } = render(
      <ApprovalCard
        icon="x"
        title="t"
        actions={<RLink faint>Back to the spec</RLink>}
        actionsJustify="end"
      />,
    );
    const actions = container.querySelector('.approval-actions') as HTMLElement;
    expect(actions.style.justifyContent).toBe('flex-end');
    expect(screen.getByText('Back to the spec')).toBeInTheDocument();
  });

  it('omits actions and foot entirely when not given', () => {
    const { container } = render(<ApprovalCard icon="x" title="t" />);
    expect(container.querySelector('.approval-actions')).not.toBeInTheDocument();
    expect(container.querySelector('.approval-foot')).not.toBeInTheDocument();
  });

  it('renders a foot note', () => {
    render(<ApprovalCard icon="x" title="t" foot={<span>OS notification sent 09:41</span>} />);
    expect(screen.getByText('OS notification sent 09:41')).toBeInTheDocument();
  });
});

describe('RLink', () => {
  it('calls onClick from a click and from Enter/Space', () => {
    const onClick = vi.fn();
    render(<RLink onClick={onClick}>Back to the proposal</RLink>);
    const link = screen.getByText('Back to the proposal');
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    fireEvent.keyDown(link, { key: ' ' });
    fireEvent.keyDown(link, { key: 'a' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});

describe('RefGrid/RefCell', () => {
  it('renders three cells with label, value and caption', () => {
    const { container } = render(
      <RefGrid>
        <RefCell label="Estimate" value="+1,340 −410" mono sub="31 files · no clean layering" />
        <RefCell label="Tripped" value="> 400 changed lines" sub="also > 20 files" />
        <RefCell label="One-PR budget" value="≤ 100 · ≤ 10" mono sub="changed lines · files" />
      </RefGrid>,
    );
    expect(container.querySelectorAll('.ref-cell')).toHaveLength(3);
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(container.querySelector('.ref-v.mono')).toBeInTheDocument();
  });
});

describe('StackList/StackNote', () => {
  it('wraps StackRows in a stack-list column', () => {
    const { container } = render(
      <StackList>
        <StackRow index="1/2" title="a" meta="m" />
        <StackRow index="2/2" title="b" meta="m" />
      </StackList>,
    );
    expect(container.querySelector('.stack-list')).toBeInTheDocument();
    expect(container.querySelectorAll('.stack-row')).toHaveLength(2);
  });

  it('renders the stack-note info line', () => {
    render(
      <StackNote>
        <b>Maintenance is read-only here.</b> Restack, rebase and the PR-to-PR view live on
        GitHub.
      </StackNote>,
    );
    expect(screen.getByText('Maintenance is read-only here.')).toBeInTheDocument();
  });
});
