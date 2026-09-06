import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardFoot, CardMeta } from '../../src/components/primitives/Card.js';
import { FailNote, WaitNote } from '../../src/components/primitives/CardNote.js';
import { Button } from '../../src/components/primitives/Button.js';

describe('FailNote', () => {
  it('renders a warning icon and the given message', () => {
    const { container } = render(
      <FailNote>Last attempt: vitest timed out in tray.test.ts after 120 s.</FailNote>,
    );
    expect(container.querySelector('.fail-note')).toBeInTheDocument();
    expect(container.querySelector('.fail-note svg')).toBeInTheDocument();
    expect(
      screen.getByText('Last attempt: vitest timed out in tray.test.ts after 120 s.'),
    ).toBeInTheDocument();
  });
});

describe('WaitNote', () => {
  it('renders a pause icon and names the overlapping file and blocking ticket', () => {
    render(
      <WaitNote>
        <b>Waiting — file overlap with #94.</b> Both plan to touch{' '}
        <span className="mono">stdio-mcp-connection.ts</span>. Starts on its own when #94
        finishes; a slot is reserved.
      </WaitNote>,
    );
    expect(screen.getByText('Waiting — file overlap with #94.')).toBeInTheDocument();
    expect(screen.getByText('stdio-mcp-connection.ts')).toBeInTheDocument();
  });
});

describe('a parked card with a note and a ghost run-anyway action', () => {
  it('composes a held card, a WaitNote and a ghost Run anyway button', () => {
    render(
      <Card id="#97" title="Retry the MCP stdio handshake once on EPIPE" held>
        <WaitNote>
          <b>Waiting — file overlap with #94.</b> Both plan to touch{' '}
          <span className="mono">stdio-mcp-connection.ts</span>.
        </WaitNote>
        <CardFoot>
          <CardMeta icon="clock">held 3m</CardMeta>
          <Button variant="ghost" size="sm">
            Run anyway
          </Button>
        </CardFoot>
      </Card>,
    );
    expect(screen.getByRole('button', { name: 'Run anyway' }).className).toContain('ghost');
    expect(screen.getByText('held 3m')).toBeInTheDocument();
  });
});
