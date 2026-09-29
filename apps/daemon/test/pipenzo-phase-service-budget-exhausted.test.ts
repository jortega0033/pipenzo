import { describe, expect, it } from 'vitest';
import { budgetExhaustedCommentBody } from '../src/pipenzo-phase-service.js';

describe('budgetExhaustedCommentBody', () => {
  it('names the real spend and the configured limit', () => {
    const body = budgetExhaustedCommentBody({ tokensUsed: 12_500, limit: 10_000 });
    expect(body).toContain('12500');
    expect(body).toContain('10000');
    expect(body).toContain('pipenzo:needs-human');
  });

  it('says the ticket is parked rather than retried', () => {
    const body = budgetExhaustedCommentBody({ tokensUsed: 500, limit: 500 });
    expect(body).toContain('Parked');
    expect(body).toContain('park it rather than retry it');
  });
});
