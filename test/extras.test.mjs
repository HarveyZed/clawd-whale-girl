// Unit tests for the extended DSH -> Clawd bridge. Run: node --test test/extras.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  mapSessionEvent, mapExtraEvent, isSubagentSession, contextUsagePayload,
} from '../lib/mapping.js';
import {
  tierFor, tierToState, pickBalanceInfo, balanceLabel, TIER_OK, TIER_WARN, TIER_CRITICAL,
} from '../lib/balance.js';
import {
  apply, createStateSender, createVirtualSession, canonicalSessionId, statePayload,
  readParamsFile, mergeParams,
} from '../lib/index.js';

// ── official mapping must stay unchanged ─────────────────────────────────────
test('official mappings unchanged', () => {
  assert.deepEqual(mapSessionEvent({ type: 'turn/start' }), { event: 'UserPromptSubmit', state: 'thinking' });
  assert.deepEqual(mapSessionEvent({ type: 'tool/call', data: { name: 'bash' } }),
    { event: 'PreToolUse', state: 'working', toolName: 'bash' });
  assert.deepEqual(mapSessionEvent({ type: 'tool/result', data: { message: { content: [] } } }),
    { event: 'PostToolUse', state: 'working' });
  assert.deepEqual(mapSessionEvent({ type: 'tool/result', data: { error: { code: 'x' } } }),
    { event: 'PostToolUseFailure', state: 'error' });
  assert.deepEqual(mapSessionEvent({ type: 'turn/end', data: { reason: 'error' } }),
    { event: 'StopFailure', state: 'error' });
  assert.deepEqual(mapSessionEvent({ type: 'turn/end', data: { reason: 'stop' } }),
    { event: 'Stop', state: 'attention' });
  assert.equal(mapSessionEvent({ type: 'assistant/message' }), null);
});

// ── new mappings ─────────────────────────────────────────────────────────────
test('extra mappings', () => {
  assert.deepEqual(mapExtraEvent({ type: 'approval/asked' }), { event: 'Notification', state: 'notification' });
  assert.deepEqual(mapExtraEvent({ type: 'approval/decided' }), { event: 'PostToolUse', state: 'working' });
  assert.deepEqual(mapExtraEvent({ type: 'subagent/descriptor' }), { event: 'SubagentStart', state: 'juggling' });
  assert.deepEqual(mapExtraEvent({ type: 'subagent/catalog' }), { event: 'SubagentStart', state: 'juggling' });
  assert.deepEqual(mapExtraEvent({ type: 'team/task' }), { event: 'SubagentStart', state: 'juggling' });
  assert.deepEqual(mapExtraEvent({ type: 'compaction/start' }), { event: 'PreCompact', state: 'sweeping' });
  assert.deepEqual(mapExtraEvent({ type: 'compaction/end' }), { event: 'PostCompact', state: 'idle' });
  assert.equal(mapExtraEvent({ type: 'compaction/prune' }), null);
  assert.equal(mapExtraEvent({ type: 'todo/write' }), null);
});

test('subagent detection', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true);
  assert.equal(isSubagentSession({ header: { delegationDepth: 2 } }), true);
  assert.equal(isSubagentSession({ header: { delegationDepth: 0 } }), false);
  assert.equal(isSubagentSession({ header: {} }), false);
  assert.equal(isSubagentSession(null), false);
});

test('context usage payload matches Clawd wire shape', () => {
  assert.deepEqual(contextUsagePayload({ surfaceTokens: 305998 }, 1000000), { used: 305998, limit: 1000000 });
  assert.deepEqual(contextUsagePayload({ surfaceTokens: 1 }, undefined), { used: 1 });
  assert.equal(contextUsagePayload({ surfaceTokens: -1 }, 10), null);
  assert.equal(contextUsagePayload(null, 10), null);
});

// ── balance tiers ────────────────────────────────────────────────────────────
test('balance tiers', () => {
  assert.equal(tierFor(15, 10), TIER_OK);
  assert.equal(tierFor(10, 10), TIER_OK);
  assert.equal(tierFor(9.99, 10), TIER_WARN);
  assert.equal(tierFor(5, 10), TIER_WARN);
  assert.equal(tierFor(4.99, 10), TIER_CRITICAL);
  assert.equal(tierFor(0, 10), TIER_CRITICAL);
  assert.equal(tierFor(5, 0), TIER_OK);
  assert.deepEqual(tierToState(TIER_WARN), { state: 'notification', event: 'Notification' });
  assert.deepEqual(tierToState(TIER_CRITICAL), { state: 'error', event: 'StopFailure' });
  assert.equal(tierToState(TIER_OK), null);
});

test('balance info pick + label', () => {
  const infos = [
    { currency: 'USD', total_balance: '3.00' },
    { currency: 'CNY', total_balance: '8.50' },
  ];
  assert.equal(pickBalanceInfo(infos, 'CNY').total_balance, '8.50');
  assert.equal(pickBalanceInfo(infos, 'EUR').total_balance, '3.00');
  assert.equal(balanceLabel({ currency: 'CNY', total_balance: '8.50' }), '余额 8.50 CNY');
  assert.equal(balanceLabel(null), '余额不可用');
});

// ── virtual session sequence (must satisfy Clawd's DSH fence) ────────────────
test('virtual session emits monotonic watermarks', () => {
  const v = createVirtualSession('deepseek-harness:balance-guard', '余额 8.50 CNY');
  const start = v.start();
  assert.equal(start.event, 'SessionStart');
  assert.equal(start.state, 'idle');
  assert.ok(Number.isSafeInteger(start.session_seq));
  assert.equal(start.event_seq, undefined);
  const warn = v.state('notification', 'Notification');
  assert.ok(warn.event_seq > start.session_seq - 1, 'event_seq must pass the session watermark');
  const crit = v.state('error', 'StopFailure');
  assert.ok(crit.event_seq > warn.event_seq);
  const end = v.end();
  assert.ok(end.session_seq > crit.event_seq);
  assert.equal(end.state, 'sleeping');
  assert.match(start.session_id, /^deepseek-harness:balance-guard$/);
});

test('virtual session never rewinds its watermark across alert cycles', () => {
  // Clawd's per-session fence outlives the plugin process: a second alert cycle
  // must stay above the previous end watermark or every post is dropped.
  const v = createVirtualSession('deepseek-harness:balance-guard', 'x', 1000);
  const s1 = v.start();
  const e1 = v.state('notification', 'Notification');
  const end1 = v.end();
  const s2 = v.start();
  const e2 = v.state('error', 'StopFailure');
  const end2 = v.end();
  assert.equal(s1.session_seq, 1000);
  assert.ok(s2.session_seq > end1.session_seq, 'restart must clear the previous end watermark');
  assert.ok(e2.event_seq > s2.session_seq - 1, 'event seq must pass the new start watermark');
  assert.ok(end2.session_seq > e2.event_seq, 'end watermark must exceed the last event');
  assert.ok(e1.event_seq > s1.session_seq - 1);
});

// ── sender FIFO ──────────────────────────────────────────────────────────────
test('state sender keeps per-session FIFO order', async () => {
  const seen = [];
  const sender = createStateSender(new AbortController().signal, async (payload) => {
    await new Promise((r) => setTimeout(r, 1));
    seen.push(payload.event);
  });
  sender.enqueue({ session_id: 's1', event: 'SessionStart' });
  sender.enqueue({ session_id: 's1', event: 'PreToolUse' });
  sender.enqueue({ session_id: 's2', event: 'Stop' });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen.filter((e) => e !== 'Stop'), ['SessionStart', 'PreToolUse']);
  assert.ok(seen.includes('Stop'));
});

test('balance retries soon when credentials are not ready at startup', async () => {
  // Regression: the credentials service is injected after apply() runs, so the very
  // first poll can fail. It must retry on firstRetryMs, not on refreshMs.
  const ctx = fakeCtx();
  const posted = [];
  let credentialsReady = false;
  ctx.inject = (deps, cb) => {
    const key = deps.join(',');
    if (key === 'credentials') {
      cb({ credentials: { resolve: async () => (credentialsReady ? { value: 'sk-test' } : undefined) } });
    }
    if (key === 'tokenMeter') cb({ tokenMeter: null });
    ctx.injected.set(key, cb);
  };
  apply(ctx, {
    permissionBubble: false,
    debugLogPath: '',
    paramsPath: '',
    balance: {
      enabled: true, threshold: 10, refreshMs: 600000, firstRetryMs: 1000,
      mode: 'flash', flashMs: 200, remindEveryMs: 0,
    },
    testPostState: async (p) => { posted.push(p); },
    testFetchBalance: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.50' }] }),
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(posted.length, 0, 'no alert while the credential is unavailable');
  credentialsReady = true;              // the service becomes ready shortly after
  await new Promise((r) => setTimeout(r, 1600));
  assert.ok(posted.some((p) => p.state === 'notification'), 'alerts once the credential resolves');
  assert.equal(posted[0].event, 'SessionStart');
});

test('params file merges over config and is read from disk', async () => {
  const merged = mergeParams(
    { contextUsage: true, balance: { threshold: 20, mode: 'flash', refreshMs: 300000 } },
    { balance: { threshold: 50 } },
  );
  assert.equal(merged.balance.threshold, 50);
  assert.equal(merged.balance.mode, 'flash', 'untouched keys survive');
  assert.equal(merged.contextUsage, true);
  assert.equal(readParamsFile(''), null);
  assert.equal(readParamsFile('does-not-exist.json'), null);
});

test('live params reload changes the balance threshold without restart', async () => {
  // resolved from this file, so the suite passes from any working directory
  const paramsFile = fileURLToPath(new URL('./.tmp-params.json', import.meta.url));
  await writeFile(paramsFile, JSON.stringify({ balance: { threshold: 10 } }), 'utf8');
  const ctx = fakeCtx();
  const posted = [];
  ctx.inject = (deps, cb) => {
    const key = deps.join(',');
    if (key === 'credentials') cb({ credentials: { resolve: async () => ({ value: 'sk-test' }) } });
    if (key === 'tokenMeter') cb({ tokenMeter: null });
    ctx.injected.set(key, cb);
  };
  apply(ctx, {
    permissionBubble: false,
    paramsPath: paramsFile,
    paramsPollMs: 150,
    debugLogPath: '',
    // sticky keeps the alert session open so the recovery path can close it
    balance: { enabled: true, refreshMs: 600000, firstRetryMs: 600000, mode: 'sticky', remindEveryMs: 0 },
    testPostState: async (p) => { posted.push(p); },
    testFetchBalance: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.00' }] }),
  });
  await new Promise((r) => setTimeout(r, 400));
  // 8.00 < threshold 10 -> warn tier alerts
  assert.ok(posted.some((p) => p.state === 'notification'), 'alert with threshold 10');
  posted.length = 0;
  await writeFile(paramsFile, JSON.stringify({ balance: { threshold: 5 } }), 'utf8');
  await new Promise((r) => setTimeout(r, 700));
  // now 8.00 > threshold 5 -> tier ok, recovered
  assert.ok(posted.some((p) => p.event === 'SessionEnd'), 'recovery after raising the bar');
  await rm(paramsFile, { force: true });
});

// ── end-to-end wiring through apply() with a fake ctx ────────────────────────
// Every effect registered through apply() is disposed in the global after() hook,
// otherwise the balance watcher interval keeps the direct-run process alive.
const disposers = [];
test.after(() => {
  for (const dispose of disposers) { try { dispose(); } catch {} }
  disposers.length = 0;
});

function fakeCtx() {
  const handlers = new Map();
  const injected = new Map();
  return {
    handlers, injected,
    on(name, fn) { handlers.set(name, fn); },
    inject(deps, cb) { injected.set(deps.join(','), cb); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    logger: { info() {} },
  };
}

function collectApply(configOverrides = {}, env = {}) {
  const ctx = fakeCtx();
  const posted = [];
  ctx.inject = (deps, cb) => {
    const key = deps.join(',');
    ctx.injected.set(key, cb);
    if (key === 'tokenMeter') cb({ tokenMeter: env.tokenMeter ?? null });
    if (key === 'credentials') cb({ credentials: env.credentials ?? null });
    if (key === 'approval') env.onApproval?.(cb);
  };
  apply(ctx, {
    balance: { enabled: false },
    permissionBubble: false,
    debugLogPath: '',
    paramsPath: '',
    testPostState: async (p) => { posted.push(p); },
    ...configOverrides,
  });
  return { ctx, posted };
}

test('apply() wires session handlers and posts context usage + extras', async () => {
  const session = { id: 'session-abc', seq: 7, header: { cwd: 'E:/proj' } };
  const { ctx, posted } = collectApply({}, {
    tokenMeter: { measure: () => ({ surfaceTokens: 305998, totalTokens: 400000 }) },
  });
  ctx.handlers.get('session/created')(session);
  ctx.handlers.get('session/event')(session, { type: 'request/context', seq: 8, data: { contextWindow: 1000000 } });
  ctx.handlers.get('session/event')(session, { type: 'tool/call', seq: 9, data: { name: 'bash' } });
  ctx.handlers.get('session/event')(session, { type: 'approval/asked', seq: 10, data: {} });
  ctx.handlers.get('session/event')(session, { type: 'compaction/start', seq: 11, data: {} });
  ctx.handlers.get('session/event')(session, { type: 'subagent/descriptor', seq: 12, data: {} });
  await new Promise((r) => setTimeout(r, 40));

  const byEvent = Object.fromEntries(posted.map((p) => [p.event, p]));
  assert.equal(byEvent.SessionStart.state, 'idle');
  assert.equal(byEvent.SessionStart.session_id, 'deepseek-harness:session-abc');
  assert.equal(byEvent.PreToolUse.state, 'working');
  assert.deepEqual(byEvent.PreToolUse.context_usage, { used: 305998, limit: 1000000 });
  assert.equal(byEvent.Notification.state, 'notification');
  assert.equal(byEvent.PreCompact.state, 'sweeping');
  assert.equal(byEvent.SubagentStart.state, 'juggling');
  assert.equal(byEvent.SubagentStart.agent_id, 'deepseek-harness');
  assert.equal(byEvent.SubagentStart.hook_source, 'dsh-plugin');
});

test('context usage falls back to the configured window when request/context never arrives', async () => {
  // Measured in production: request/context is not delivered to this plugin's
  // session/event listener, so the limit must come from contextWindowFallback.
  const session = { id: 'session-noctx', seq: 1, header: {} };
  const { ctx, posted } = collectApply({ contextWindowFallback: 500000 }, {
    tokenMeter: { measure: () => ({ surfaceTokens: 12345 }) },
  });
  ctx.handlers.get('session/event')(session, { type: 'tool/call', seq: 2, data: { name: 'bash' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(posted[0].context_usage, { used: 12345, limit: 500000 });
});

test('request/context overrides the fallback window', async () => {
  const session = { id: 'session-ctx', seq: 1, header: {} };
  const { ctx, posted } = collectApply({ contextWindowFallback: 500000 }, {
    tokenMeter: { measure: () => ({ surfaceTokens: 999 }) },
  });
  ctx.handlers.get('session/event')(session, { type: 'request/context', seq: 2, data: { contextWindow: 200000 } });
  ctx.handlers.get('session/event')(session, { type: 'tool/call', seq: 3, data: { name: 'bash' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(posted[0].context_usage, { used: 999, limit: 200000 });
});

test('subagent session reports juggling and stays non-headless', async () => {
  const session = { id: 'session-child', seq: 3, header: { origin: 'subagent', cwd: 'E:/proj' } };
  const { ctx, posted } = collectApply();
  ctx.handlers.get('session/created')(session);
  ctx.handlers.get('session/event')(session, { type: 'tool/call', seq: 4, data: { name: 'read' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(posted[0].state, 'juggling');
  assert.equal(posted[0].headless, undefined);
  assert.equal(posted[0].recap_is_subagent, true);
  assert.equal(posted[1].state, 'juggling');
});

test('feature switches turn extras off', async () => {
  const session = { id: 'session-off', seq: 1, header: {} };
  const { ctx, posted } = collectApply({
    approvalNotification: false, compactionSweeping: false, subagentJuggling: false, contextUsage: false,
  });
  ctx.handlers.get('session/event')(session, { type: 'approval/asked', seq: 2, data: {} });
  ctx.handlers.get('session/event')(session, { type: 'compaction/start', seq: 3, data: {} });
  ctx.handlers.get('session/event')(session, { type: 'tool/call', seq: 4, data: { name: 'bash' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].event, 'PreToolUse');
  assert.equal(posted[0].context_usage, undefined);
});

test('balance watcher drives an isolated virtual session', async () => {
  const ctx = fakeCtx();
  const posted = [];
  ctx.inject = (deps, cb) => {
    const key = deps.join(',');
    if (key === 'credentials') cb({ credentials: { resolve: async () => ({ value: 'sk-test' }) } });
    if (key === 'tokenMeter') cb({ tokenMeter: null });
    ctx.injected.set(key, cb);
  };
  let balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.50' }] };
  apply(ctx, {
    permissionBubble: false,
    debugLogPath: '',
    paramsPath: '',
    balance: { enabled: true, threshold: 10, refreshMs: 60000, mode: 'flash', flashMs: 1000, remindEveryMs: 0 },
    testPostState: async (p) => { posted.push(p); },
    testFetchBalance: async () => balance,
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(posted[0].event, 'SessionStart');
  assert.match(posted[0].session_id, /^deepseek-harness:balance-guard-\d+$/);
  assert.match(posted[0].session_title, /8\.50/);
  assert.equal(posted[1].state, 'notification');
  assert.ok(Number.isSafeInteger(posted[1].event_seq));
  // below half the threshold -> error tier on the next poll
  balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3.00' }] };
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(posted[posted.length - 1].event, 'SessionEnd');
});
