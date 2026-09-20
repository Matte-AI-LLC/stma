import { expect, it } from 'vitest';
import { environmentNotice } from '../../cli/src/notices';

it('delivers semantic environment verdicts without reflecting untrusted data', () => {
  expect(environmentNotice({ status: 'critical', secret: 'do-not-copy' })).toContain('CRITICAL');
  expect(environmentNotice({ status: 'critical', secret: 'do-not-copy' })).not.toContain('do-not-copy');
  expect(environmentNotice({ status: 'no_baseline' })).toContain('not been verified');
  expect(environmentNotice({ status: 'unknown' })).toContain('unknown');
  expect(environmentNotice(null)).toContain('unknown');
  expect(environmentNotice({ status: 'ok' })).toBeUndefined();
});
