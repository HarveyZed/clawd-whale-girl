// DeepSeek balance polling + threshold tiering (pure parts are unit-tested).

export const TIER_OK = 'ok';
export const TIER_WARN = 'warn';
export const TIER_CRITICAL = 'critical';

/** Balance -> tier. critical = below half the threshold, warn = below the threshold. */
export function tierFor(balance, threshold) {
  const b = Number(balance);
  const t = Number(threshold);
  if (!Number.isFinite(b) || !Number.isFinite(t) || t <= 0) return TIER_OK;
  if (b < t * 0.5) return TIER_CRITICAL;
  if (b < t) return TIER_WARN;
  return TIER_OK;
}

/** Clawd has no dedicated balance surface, so a low balance borrows a state animation. */
export function tierToState(tier) {
  if (tier === TIER_CRITICAL) return { state: 'error', event: 'StopFailure' };
  if (tier === TIER_WARN) return { state: 'notification', event: 'Notification' };
  return null;
}

/** Pick the requested currency, else the first entry. */
export function pickBalanceInfo(infos, currency) {
  if (!Array.isArray(infos) || infos.length === 0) return null;
  const wanted = typeof currency === 'string' && currency ? currency.toUpperCase() : null;
  if (wanted) {
    const hit = infos.find((item) => String(item?.currency ?? '').toUpperCase() === wanted);
    if (hit) return hit;
  }
  return infos[0] ?? null;
}

/** Short label for the virtual session row, e.g. "余额 8.50 CNY". */
export function balanceLabel(info) {
  if (!info) return '余额不可用';
  const amount = String(info.total_balance ?? '?');
  const currency = String(info.currency ?? '');
  return `余额 ${amount} ${currency}`.trim();
}

/** GET <baseUrl><endpoint> with Bearer auth. Throws on non-2xx. */
export async function fetchBalance(options = {}) {
  const baseUrl = String(options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const endpoint = String(options.endpoint ?? '/user/balance');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error('missing DeepSeek API key');
  const res = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`balance endpoint returned ${res.status}`);
  return await res.json();
}
