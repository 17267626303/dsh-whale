// Verified official list prices, not an account bill. Unknown models stay unknown.
export const PRICE_AS_OF = '2026-10-09';
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const FLASH = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
const HOLIDAYS = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
];

export function officialRates({ provider, model, at }, currency = 'CNY') {
  if (!['deepseek-official', 'deepseek-account'].includes(provider)) return null;
  const family = FLASH.has(model) ? 'flash' : model === 'deepseek-v4-pro' ? 'pro' : null;
  if (!family || !['CNY', 'USD'].includes(currency)) return null;
  // Do not apply today's prices to historical records or guess next year's holidays.
  if (!Number.isSafeInteger(at) || at < Date.parse('2026-09-10T00:00:00+08:00')
    || at >= Date.parse('2027-01-01T00:00:00+08:00')) return null;
  const peak = isPeak(at);
  const prices = {
    CNY: { flash: peak ? ['2', '0.04', '8'] : ['1', '0.02', '4'], pro: peak ? ['9', '0.30', '27'] : ['4.5', '0.15', '13.5'] },
    USD: { flash: peak ? ['0.3', '0.006', '1.2'] : ['0.15', '0.003', '0.6'], pro: peak ? ['1.32', '0.044', '3.96'] : ['0.66', '0.022', '1.98'] },
  }[currency][family];
  return { provider, model, currency, inputPerMillion: prices[0], cacheHitPerMillion: prices[1], outputPerMillion: prices[2], sourceUrl: PRICE_SOURCE, asOf: PRICE_AS_OF };
}

export function isPeak(at) {
  const date = new Date(at);
  const beijing = new Date(at + 8 * 60 * 60 * 1000);
  const day = `${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;
  if ([0, 6].includes(beijing.getUTCDay()) || HOLIDAYS.some(([from, to]) => day >= from && day <= to)) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return minutes >= 60 && minutes < 240 || minutes >= 360 && minutes < 600;
}
