import test from 'node:test';
import assert from 'node:assert/strict';
import { officialRates } from '../lib/deepseek-pricing.mjs';

const price = (date, model = 'deepseek-flash', currency = 'CNY', provider = 'deepseek-official') => officialRates({ provider, model, at: Date.parse(date) }, currency);
test('official pricing respects peak boundaries, weekends and 2026 holidays', () => {
  assert.equal(price('2026-10-09T09:00:00+08:00').inputPerMillion, '2');
  assert.equal(price('2026-10-09T11:59:59+08:00').inputPerMillion, '2');
  assert.equal(price('2026-10-09T12:00:00+08:00').inputPerMillion, '1');
  assert.equal(price('2026-10-09T14:00:00+08:00').outputPerMillion, '8');
  assert.equal(price('2026-10-09T18:00:00+08:00').outputPerMillion, '4');
  assert.equal(price('2026-10-10T09:00:00+08:00').inputPerMillion, '1');
  assert.equal(price('2026-10-06T09:00:00+08:00').inputPerMillion, '1');
  assert.equal(price('2026-10-09T09:00:00+08:00', 'deepseek-v4-pro', 'USD').cacheHitPerMillion, '0.044');
});
test('unknown providers, retired models and unsupported price dates never imply a free request', () => {
  assert.equal(price('2026-10-09T09:00:00+08:00', 'deepseek-chat'), null);
  assert.equal(price('2026-10-09T09:00:00+08:00', 'deepseek-flash', 'CNY', 'third-party'), null);
  assert.equal(price('2026-09-01T09:00:00+08:00'), null);
  assert.equal(price('2027-01-04T09:00:00+08:00'), null);
  assert.ok(price('2026-10-09T09:00:00+08:00', 'deepseek-v4-flash'));
});
