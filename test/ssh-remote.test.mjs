// SSH-host transport tests: Clawd on Desk steering a *remote* DSH.
//
// Clawd's SSH host mode binds a reverse forward on this machine
// (ssh -R 127.0.0.1:<remotePort>:127.0.0.1:<appPort>) and routes everything
// through its src/remote-ssh-ingress.js, which only accepts /state and
// /permission carrying the profile's x-clawd-routing-nonce. These tests stand
// up a fake ingress with exactly those rules — no Clawd and no DSH needed —
// then drive lib/clawd-client.js and the real plugin against it.
//
// Run: node --test test/ssh-remote.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { postState, clearCachedPortForTest, __test } from '../lib/clawd-client.js';

const PORTS = [23333, 23334, 23335, 23336, 23337];
const NONCE = 'a'.repeat(32);

/** Fake Clawd SSH ingress: state/permission only, nonce required, else 404. */
function createIngress() {
  const state = { received: [], permissions: [], rejected: 0, decisions: [] };
  const server = http.createServer((req, res) => {
    const nonce = String(req.headers[__test.routingNonceHeader] || '');
    const allowed = ((req.method === 'GET' || req.method === 'POST') && req.url === '/state')
      || (req.method === 'POST' && req.url === '/permission');
    if (!allowed || nonce !== NONCE) {
      state.rejected += 1;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'x-clawd-server': 'clawd-on-desk', 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'clawd-on-desk' }));
        return;
      }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      if (req.url === '/permission') {
        state.permissions.push(body);
        const decision = state.decisions.shift() ?? 'none';
        if (decision === 'none') {
          res.writeHead(204, { 'x-clawd-server': 'clawd-on-desk' });
          res.end();
          return;
        }
        res.writeHead(200, { 'x-clawd-server': 'clawd-on-desk', 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision }));
        return;
      }
      state.received.push(body);
      res.writeHead(200, { 'x-clawd-server': 'clawd-on-desk', 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, state };
}

async function listenOnIngressPort() {
  for (const port of PORTS) {
    const ingress = createIngress();
    try {
      ingress.server.listen(port, '127.0.0.1');
      await once(ingress.server, 'listening');
      return { ...ingress, port };
    } catch {
      ingress.server.close();
    }
  }
  return null;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** Minimal cordis context: records listeners, runs injections eagerly. */
function createStubContext() {
  const listeners = new Map();
  const injections = [];
  const disposers = [];
  return {
    injections,
    listeners,
    disposers,
    emit(name, ...args) {
      for (const handler of listeners.get(name) || []) handler(...args);
    },
    ctx: {
      on(name, handler, options) {
        const list = listeners.get(name) || [];
        if (options?.prepend) list.unshift(handler); else list.push(handler);
        listeners.set(name, list);
        return () => {};
      },
      inject(deps, callback) {
        injections.push({ deps, callback });
        const injected = {};
        for (const dep of deps) injected[dep] = { on: () => () => {}, webServer: undefined }[dep];
        callback(injected);
      },
      effect(factory) {
        const disposer = typeof factory === 'function' ? factory() : undefined;
        if (typeof disposer === 'function') disposers.push(disposer);
        return disposer;
      },
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    },
  };
}

test('remote identity validation mirrors the Clawd hook contract', () => {
  const good = {
    version: 2, layoutVersion: 1, runtimeKey: 'account-default', profileId: 'testprofile01',
    installId: 'f'.repeat(64), remotePort: 23333, routingNonce: NONCE, deployedAt: 1,
  };
  assert.equal(__test.validateRemoteIdentity(good)?.routingNonce, NONCE);
  assert.equal(__test.validateRemoteIdentity({ ...good, version: 1 }), null);
  assert.equal(__test.validateRemoteIdentity({ ...good, routingNonce: 'zz' }), null);
  assert.equal(__test.validateRemoteIdentity({ ...good, remotePort: 9999 }), null);
  assert.equal(__test.validateRemoteIdentity({ ...good, installId: 'short' }), null);
  assert.equal(__test.validateRemoteIdentity({ ...good, deployedAt: 0 }), null);
  assert.equal(__test.validateRemoteIdentity(null), null);
});

test('SSH-host transport: nonce required, discovery targets the forward port',
  async (t) => {
    const bound = await listenOnIngressPort();
    if (!bound) {
      t.skip('no free port in 23333-23337 to host the fake ingress');
      return;
    }
    const { server, state, port } = bound;
    const dir = await mkdtemp(join(tmpdir(), 'clawd-extras-test-'));
    const identityPath = join(dir, 'clawd-remote.json');
    await writeFile(identityPath, JSON.stringify({
      version: 2, layoutVersion: 1, runtimeKey: 'account-default', profileId: 'testprofile01',
      installId: 'f'.repeat(64), remotePort: port, routingNonce: NONCE, deployedAt: Date.now(),
    }));
    const previous = process.env.CLAWD_REMOTE_IDENTITY_PATH;
    process.env.CLAWD_REMOTE_IDENTITY_PATH = identityPath;
    clearCachedPortForTest();
    t.after(async () => {
      server.close();
      await rm(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.CLAWD_REMOTE_IDENTITY_PATH;
      else process.env.CLAWD_REMOTE_IDENTITY_PATH = previous;
      clearCachedPortForTest();
    });

    const identity = await __test.readRemoteIdentity();
    assert.equal(identity?.remotePort, port);

    // Negative controls: this is exactly why the upstream client never saw a
    // remote Clawd — without the nonce the ingress answers 404.
    const noNonce = await __test.request(port, 'GET', '/state', undefined, { timeoutMs: 1000 });
    assert.equal(noNonce.statusCode, 404);
    const wrongNonce = await __test.request(port, 'GET', '/state', undefined, {
      timeoutMs: 1000, nonce: 'b'.repeat(32),
    });
    assert.equal(wrongNonce.statusCode, 404);

    // Discovery must resolve the remote transport, nonce attached.
    const transport = await __test.probe(port, { nonce: NONCE });
    assert.equal(transport, true);
    const posted = await postState({ agent_id: 'deepseek-harness', session_id: 'deepseek-harness:probe' });
    assert.equal(posted.ok, true);
    assert.equal(state.received.length, 1);
    assert.equal(state.rejected, 2, 'only the two deliberate negative controls were rejected');
  });

test('plugin end-to-end over the SSH-host transport', async (t) => {
  const bound = await listenOnIngressPort();
  if (!bound) {
    t.skip('no free port in 23333-23337 to host the fake ingress');
    return;
  }
  const { server, state, port } = bound;
  const dir = await mkdtemp(join(tmpdir(), 'clawd-extras-test-'));
  const identityPath = join(dir, 'clawd-remote.json');
  await writeFile(identityPath, JSON.stringify({
    version: 2, layoutVersion: 1, runtimeKey: 'account-default', profileId: 'testprofile01',
    installId: 'f'.repeat(64), remotePort: port, routingNonce: NONCE, deployedAt: Date.now(),
  }));
  const previous = process.env.CLAWD_REMOTE_IDENTITY_PATH;
  process.env.CLAWD_REMOTE_IDENTITY_PATH = identityPath;
  clearCachedPortForTest();
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAWD_REMOTE_IDENTITY_PATH;
    else process.env.CLAWD_REMOTE_IDENTITY_PATH = previous;
    clearCachedPortForTest();
  });

  const { apply } = await import('../lib/index.js');
  const stub = createStubContext();
  // debugLogPath '' = off, paramsPath '' = no watcher, balance off = no network.
  apply(stub.ctx, { debugLogPath: '', paramsPath: '', balance: { enabled: false } });
  t.after(() => { for (const dispose of stub.disposers) { try { dispose(); } catch {} } });

  assert.ok(stub.listeners.has('session/created'), 'registers session listeners');
  assert.ok(stub.injections.some((entry) => entry.deps.includes('approval')), 'wires the approval waterfall');

  const session = { id: 'sess-live', seq: 0, header: { cwd: '/srv/project' } };
  stub.emit('session/created', session);
  stub.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  stub.emit('session/event', session, { type: 'tool/call', seq: 2, data: { name: 'run_code' } });
  stub.emit('session/event', session, { type: 'turn/end', seq: 3, data: { reason: 'stop' } });
  stub.emit('session/disposed', session);

  const drained = await waitFor(() => state.received.length >= 5);
  assert.ok(drained, `expected 5 payloads, got ${state.received.length}`);

  const pairs = state.received.map((item) => [item.event, item.state]);
  assert.deepEqual(pairs.slice(0, 4), [
    ['SessionStart', 'idle'], ['UserPromptSubmit', 'thinking'],
    ['PreToolUse', 'working'], ['Stop', 'attention'],
  ]);
  const first = state.received[0];
  assert.equal(first.agent_id, 'deepseek-harness');
  assert.equal(first.hook_source, 'dsh-plugin');
  assert.equal(first.session_id, 'deepseek-harness:sess-live');
  assert.equal(first.session_seq, 0);
  assert.equal(first.cwd, '/srv/project');
  assert.equal(state.received[2].tool_name, 'run_code');
  assert.equal(state.received[2].event_seq, 2);
  assert.equal(state.rejected, 0, 'the plugin never posts without the nonce');
});

test('approval round trip over the SSH-host transport', async (t) => {
  const bound = await listenOnIngressPort();
  if (!bound) {
    t.skip('no free port in 23333-23337 to host the fake ingress');
    return;
  }
  const { server, state, port } = bound;
  const dir = await mkdtemp(join(tmpdir(), 'clawd-extras-test-'));
  const identityPath = join(dir, 'clawd-remote.json');
  await writeFile(identityPath, JSON.stringify({
    version: 2, layoutVersion: 1, runtimeKey: 'account-default', profileId: 'testprofile01',
    installId: 'f'.repeat(64), remotePort: port, routingNonce: NONCE, deployedAt: Date.now(),
  }));
  const previous = process.env.CLAWD_REMOTE_IDENTITY_PATH;
  process.env.CLAWD_REMOTE_IDENTITY_PATH = identityPath;
  clearCachedPortForTest();
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAWD_REMOTE_IDENTITY_PATH;
    else process.env.CLAWD_REMOTE_IDENTITY_PATH = previous;
    clearCachedPortForTest();
  });

  const { apply } = await import('../lib/index.js');
  const stub = createStubContext();
  apply(stub.ctx, { debugLogPath: '', paramsPath: '', balance: { enabled: false } });
  t.after(() => { for (const dispose of stub.disposers) { try { dispose(); } catch {} } });

  const approvalEntry = stub.injections.find((entry) => entry.deps.includes('approval'));
  let handler = null;
  approvalEntry.callback({ on: (name, fn) => { handler = fn; return () => {}; } });
  assert.equal(typeof handler, 'function');

  const req = {
    toolName: 'run_code',
    callId: 'call-1',
    reason: 'needs approval',
    signal: new AbortController().signal,
    agent: { session: { id: 'sess-approve', seq: 0, header: { cwd: '/tmp' } } },
  };
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; return 'unavailable'; };

  state.decisions.push('allow');
  assert.equal(await handler(req, next), 'allowed-once');
  state.decisions.push('deny');
  assert.equal(await handler(req, next), 'rejected');
  state.decisions.push('none');
  assert.equal(await handler(req, next), 'unavailable', '204 falls through to DSH');
  assert.equal(nextCalls, 1);
  assert.equal(state.permissions.length, 3);
  assert.equal(state.permissions[0].session_id, 'deepseek-harness:sess-approve');
  assert.deepEqual(state.permissions[0].tool_input, {}, 'no tool arguments are forwarded');
});
