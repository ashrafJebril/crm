import { PIPEBOARD_UNGATED, isUngatedPipeboardTool } from './pipeboard-allowlist';

describe('PIPEBOARD_UNGATED', () => {
  it('holds exactly 54 tools', () => {
    expect(PIPEBOARD_UNGATED.size).toBe(54);
  });
});

describe('isUngatedPipeboardTool', () => {
  it('allows a known read-only tool', () => {
    expect(isUngatedPipeboardTool('get_insights')).toBe(true);
  });

  it('gates a known write tool', () => {
    expect(isUngatedPipeboardTool('update_campaign')).toBe(false);
  });

  it('gates an unknown tool (fail-closed)', () => {
    expect(isUngatedPipeboardTool('never_heard_of_it')).toBe(false);
  });
});
