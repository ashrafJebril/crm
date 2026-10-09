import { hashAction } from './ads-args-hash';

describe('hashAction', () => {
  it('returns the same hash for the same {tool, args, summary}, regardless of key order', () => {
    const h1 = hashAction('update_campaign', { daily_budget: 5000, name: 'x' }, 'summary text');
    const h2 = hashAction('update_campaign', { name: 'x', daily_budget: 5000 }, 'summary text');
    expect(h1).toBe(h2);
  });

  it('changes when the args change', () => {
    const base = hashAction('update_campaign', { daily_budget: 5000 }, 'summary text');
    const changed = hashAction('update_campaign', { daily_budget: 5001 }, 'summary text');
    expect(changed).not.toBe(base);
  });

  it('changes when the summary changes', () => {
    const base = hashAction('update_campaign', { daily_budget: 5000 }, 'summary text');
    const changed = hashAction('update_campaign', { daily_budget: 5000 }, 'a different summary');
    expect(changed).not.toBe(base);
  });

  it('changes when the tool changes (tool-only swap must not pass)', () => {
    const base = hashAction('update_campaign', { daily_budget: 5000 }, 'summary text');
    const changed = hashAction('pause_campaign', { daily_budget: 5000 }, 'summary text');
    expect(changed).not.toBe(base);
  });
});
