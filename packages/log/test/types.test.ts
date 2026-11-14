import { expectTypeOf, it } from 'vitest';
import { createLogger, memorySink } from '../src/index.ts';

// These are checked by `tsc`; vitest only needs them to exist.
it('only accepts literal messages and declared fields', () => {
  const log = createLogger({ service: 's', fields: ['platform'], sink: memorySink() });
  const email: string = 'alex@example.com';

  log.info('fixed message', { platform: 'youtube' });
  // @ts-expect-error A message built from data is a plain string, not a literal.
  log.info(`sent to ${email}`);
  // @ts-expect-error A string variable is not a literal either.
  log.info(email);
  // @ts-expect-error A field that was not declared.
  log.info('fixed message', { email });

  expectTypeOf(log.with({ platform: 'x' })).toEqualTypeOf(log);
});
