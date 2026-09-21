// Clawd HTTP client: transport discovery + /state, /permission delivery.
//
// Two transports, resolved per discovery:
//
//   local  — Clawd runs on this machine: read ~/.clawd/runtime.json, else scan
//            the documented 23333-23337 range. (Upstream behaviour, unchanged.)
//   remote — this machine is a Clawd *SSH host*: the desk app holds a reverse
//            forward (ssh -R 127.0.0.1:<remotePort>:127.0.0.1:<appPort>) and
//            routes everything through its src/remote-ssh-ingress.js, which
//            only accepts /state (GET, POST) and /permission (POST) carrying
//            that profile's x-clawd-routing-nonce — anything else gets 404.
//            So in this mode the only reachable endpoint is <remotePort>, and
//            every probe and post must carry the nonce.
//
// The remote identity is the clawd-remote.json Clawd writes next to the hooks
// it deploys over SSH. It is re-read on every discovery (never cached across a
// transport change), so a redeploy — new nonce or new port — self-heals on the
// next failed post.

import http from 'node:http'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SERVER_ID = 'clawd-on-desk'
const SERVER_HEADER = 'x-clawd-server'
const ROUTING_NONCE_HEADER = 'x-clawd-routing-nonce'
const PORTS = Object.freeze([23333, 23334, 23335, 23336, 23337])
const RUNTIME_PATH = join(homedir(), '.clawd', 'runtime.json')
const REMOTE_IDENTITY_FILENAME = 'clawd-remote.json'
// Clawd's own “this host is a managed SSH remote” signals (hooks/server-config.js
// isSshSecureMode). Either one means a missing/unusable identity must fail closed
// instead of falling back to the local port scan.
const SECURE_MARKER_FILENAME = 'clawd-ssh-secure-v1'
const SECURE_MARKER_ENV = 'CLAWD_SSH_SECURE_MARKER_PATH'
const REMOTE_FLAG_ENV = 'CLAWD_SSH_REMOTE'
const REMOTE_IDENTITY_VERSION = 2
const ROUTING_NONCE_RE = /^[a-f0-9]{32}$/
const INSTALL_ID_RE = /^[a-f0-9]{64}$/
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_RESPONSE_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 500
const STATE_TIMEOUT_MS = 1000
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const DISCOVERY_COOLDOWN_MS = 1000

let cachedTransport = null
let discoveryPromise = null
let retryAfter = 0

function validPort(value) {
  return Number.isInteger(value) && PORTS.includes(value)
}

function finishOnce(resolve) {
  let settled = false
  return (value) => {
    if (settled) return
    settled = true
    resolve(value)
  }
}

/**
 * Identity file candidates, most specific first. CLAWD_REMOTE_IDENTITY_PATH
 * mirrors the override Clawd's own command hooks honour; ~/.claude/hooks is
 * where the SSH deploy stages clawd-remote.json.
 */
function remoteIdentityPaths(env = process.env, home = homedir()) {
  const paths = []
  const override = typeof env.CLAWD_REMOTE_IDENTITY_PATH === 'string'
    ? env.CLAWD_REMOTE_IDENTITY_PATH.trim()
    : ''
  if (override) paths.push(override)
  paths.push(join(home, '.claude', 'hooks', REMOTE_IDENTITY_FILENAME))
  paths.push(join(home, '.clawd', REMOTE_IDENTITY_FILENAME))
  return [...new Set(paths)]
}

/**
 * Shape-validate a parsed clawd-remote.json exactly as Clawd's hooks do
 * (hooks/server-config.js readRemoteIdentity). A malformed identity is not a
 * licence to fall back to the local scan: this host *is* a managed SSH remote,
 * so a half-deployed identity must read as unavailable rather than as traffic
 * to some unrelated local port.
 */
function validateRemoteIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.version !== REMOTE_IDENTITY_VERSION) return null
  if (!Number.isInteger(raw.layoutVersion) || raw.layoutVersion <= 0) return null
  if (!SAFE_ID_RE.test(raw.runtimeKey || '')) return null
  if (!SAFE_ID_RE.test(raw.profileId || '')) return null
  if (!INSTALL_ID_RE.test(raw.installId || '')) return null
  if (!validPort(raw.remotePort)) return null
  if (!ROUTING_NONCE_RE.test(raw.routingNonce || '')) return null
  if (!Number.isFinite(raw.deployedAt) || raw.deployedAt <= 0) return null
  return {
    remotePort: raw.remotePort,
    routingNonce: raw.routingNonce,
    profileId: raw.profileId,
    installId: raw.installId,
    deployedAt: raw.deployedAt,
  }
}

function envFlag(value) {
  return !!value && !/^(0|false)$/i.test(String(value).trim())
}

/** Secure-marker candidates: the explicit override plus one beside each identity path. */
function secureMarkerPaths(options = {}) {
  const env = options.env || process.env
  const override = typeof env[SECURE_MARKER_ENV] === 'string' ? env[SECURE_MARKER_ENV].trim() : ''
  if (override) return [override]
  const paths = options.paths || remoteIdentityPaths(options.env, options.home)
  return paths.map((filePath) => join(dirname(filePath), SECURE_MARKER_FILENAME))
}

async function isManagedRemoteHost(options = {}) {
  const env = options.env || process.env
  if (envFlag(env[REMOTE_FLAG_ENV])) return true
  const access = options.accessFile || fs.access
  for (const marker of secureMarkerPaths(options)) {
    try {
      await access(marker)
      return true
    } catch {}
  }
  return false
}

/**
 * Resolve the identity as one of three states, because "no file" and "a file we
 * cannot use" mean opposite things here:
 *
 *   absent  - nothing was ever deployed: an ordinary desktop install. Upstream
 *             behaviour applies (runtime.json, then the 23333-23337 scan).
 *   invalid - a file exists (or Clawd itself marked this host as a managed SSH
 *             remote) but is unreadable / malformed / half-deployed. This host
 *             *is* a remote, so it must read as unavailable - never as traffic to
 *             some unrelated local port. Mirrors Clawd's own fail-closed hooks.
 *   valid   - pinned transport: remotePort + nonce.
 */
async function identityState(options = {}) {
  const paths = options.paths || remoteIdentityPaths(options.env, options.home)
  const readFile = options.readFile || fs.readFile
  for (const filePath of paths) {
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      // ENOENT/ENOTDIR: this candidate was simply never deployed here.
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue
      // EACCES/EIO/...: the file is there but unusable, so treat it as managed.
      return { status: 'invalid', filePath, reason: 'identity-unreadable', identity: null }
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      return { status: 'invalid', filePath, reason: 'identity-unparsable', identity: null }
    }
    const identity = validateRemoteIdentity(raw)
    if (!identity) return { status: 'invalid', filePath, reason: 'identity-invalid', identity: null }
    return { status: 'valid', filePath, reason: null, identity: { ...identity, filePath } }
  }
  if (await isManagedRemoteHost(options)) {
    return { status: 'invalid', filePath: null, reason: 'identity-missing-on-managed-remote', identity: null }
  }
  return { status: 'absent', filePath: null, reason: null, identity: null }
}

/** Convenience view for diagnostics: the validated identity, or null. */
async function readRemoteIdentity(options = {}) {
  const state = await identityState(options)
  return state.status === 'valid' ? state.identity : null
}

function request(port, method, pathname, body, options = {}) {
  return new Promise((resolve) => {
    const finish = finishOnce(resolve)
    const signal = options.signal
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS
    const maxResponseBytes = Number.isFinite(options.maxResponseBytes)
      ? options.maxResponseBytes
      : MAX_RESPONSE_BYTES
    const nonce = typeof options.nonce === 'string' && ROUTING_NONCE_RE.test(options.nonce)
      ? options.nonce
      : null
    const payload = body === undefined ? null : JSON.stringify(body)
    let abortHandler = null
    let response = null
    let responseBytes = 0
    const chunks = []

    const cleanup = () => {
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
    const done = (value) => {
      cleanup()
      finish(value)
    }

    let req
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          ...(payload === null ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          // The SSH ingress answers 404 to every request without this.
          ...(nonce === null ? {} : { [ROUTING_NONCE_HEADER]: nonce }),
        },
      }, (res) => {
        response = res
        res.on('data', (chunk) => {
          responseBytes += chunk.length
          if (responseBytes > maxResponseBytes) {
            req.destroy()
            done({ ok: false, reason: 'response-too-large' })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const server = String(res.headers[SERVER_HEADER] || '')
          if (server !== SERVER_ID) {
            done({ ok: false, reason: 'wrong-server', statusCode: res.statusCode })
            return
          }
          done({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', () => done({ ok: false, reason: 'response-error' }))
      })
    } catch {
      done({ ok: false, reason: 'request-create-failed' })
      return
    }

    req.on('error', () => done({ ok: false, reason: 'request-error' }))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done({ ok: false, reason: 'timeout' })
    })
    abortHandler = () => {
      req.destroy()
      done({ ok: false, reason: 'aborted', aborted: true })
    }
    if (signal) {
      if (signal.aborted) {
        abortHandler()
        return
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    if (payload !== null) req.write(payload)
    req.end()
  })
}

async function runtimePort() {
  try {
    const parsed = JSON.parse(await fs.readFile(RUNTIME_PATH, 'utf8'))
    return parsed?.app === SERVER_ID && validPort(parsed.port) ? parsed.port : null
  } catch {
    return null
  }
}

async function probe(port, transport = null) {
  const result = await request(port, 'GET', '/state', undefined, {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxResponseBytes: 4096,
    nonce: transport ? transport.nonce : null,
  })
  if (!result.ok || result.statusCode !== 200) return false
  try {
    const parsed = JSON.parse(result.body)
    return parsed?.app === SERVER_ID && parsed?.ok === true
  } catch {
    return false
  }
}

async function discoverUncached(options = {}) {
  const probeImpl = options.probe || probe
  const state = await identityState(options)
  if (state.status === 'valid') {
    const { remotePort, routingNonce } = state.identity
    const transport = { port: remotePort, nonce: routingNonce, source: 'ssh-remote' }
    // No port scan here: in SSH-host mode the app's own forward is the only
    // reachable endpoint, and probing the rest would just generate 404s.
    if (await probeImpl(transport.port, transport)) {
      cachedTransport = transport
      retryAfter = 0
      return transport
    }
    cachedTransport = null
    retryAfter = Date.now() + DISCOVERY_COOLDOWN_MS
    return null
  }
  if (state.status === 'invalid') {
    // Managed SSH remote with an identity we cannot trust (state.reason).
    // Report unavailability; never scan, or a local Clawd on this host would
    // receive another machine's states and approval requests.
    cachedTransport = null
    retryAfter = Date.now() + DISCOVERY_COOLDOWN_MS
    return null
  }

  const preferred = await runtimePort()
  const candidates = preferred === null
    ? PORTS
    : [preferred, ...PORTS.filter((port) => port !== preferred)]
  for (const port of candidates) {
    if (await probeImpl(port)) {
      cachedTransport = { port, nonce: null, source: 'local' }
      retryAfter = 0
      return cachedTransport
    }
  }
  cachedTransport = null
  retryAfter = Date.now() + DISCOVERY_COOLDOWN_MS
  return null
}

function waitForDiscovery(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(finish, () => finish(null))
  })
}

async function discover(signal) {
  if (cachedTransport) return cachedTransport
  if (Date.now() < retryAfter) return null
  if (!discoveryPromise) {
    // Discovery is shared, but caller cancellation is not. Binding this scan
    // to the first caller's signal lets one aborted approval cancel unrelated
    // state or approval traffic. Each caller races its own signal below.
    discoveryPromise = discoverUncached().finally(() => {
      discoveryPromise = null
    })
  }
  return waitForDiscovery(discoveryPromise, signal)
}

async function post(pathname, body, options = {}) {
  const transport = await discover(options.signal)
  if (transport === null) return { ok: false, reason: 'clawd-unavailable' }
  const first = await request(transport.port, 'POST', pathname, body, { ...options, nonce: transport.nonce })
  if (first.ok || first.aborted) return first
  cachedTransport = null
  if (options.retry === false) return first
  const retryTransport = await discover(options.signal)
  if (retryTransport === null) return first
  return request(retryTransport.port, 'POST', pathname, body, {
    ...options,
    nonce: retryTransport.nonce,
    retry: false,
  })
}

export async function postState(body, options = {}) {
  return post('/state', body, {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : STATE_TIMEOUT_MS,
    maxResponseBytes: 4096,
  })
}

export function parsePermissionResult(result) {
  if (result?.aborted) return { kind: 'cancelled' }
  if (!result?.ok) return { kind: 'no-decision' }
  if (result.statusCode === 204) return { kind: 'no-decision' }
  if (result.statusCode !== 200 || !result.body) return { kind: 'no-decision' }
  try {
    const parsed = JSON.parse(result.body)
    return parsed?.decision === 'allow' || parsed?.decision === 'deny'
      ? { kind: 'decision', decision: parsed.decision }
      : { kind: 'no-decision' }
  } catch {
    return { kind: 'no-decision' }
  }
}

export async function requestPermission(body, options = {}) {
  const result = await post('/permission', body, {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : PERMISSION_TIMEOUT_MS,
    maxResponseBytes: 16 * 1024,
    // A blocking approval POST may have reached Clawd before the connection
    // failed. Do not create a second pending decision by replaying it.
    retry: false,
  })
  return parsePermissionResult(result)
}

export function clearCachedPortForTest() {
  cachedTransport = null
  discoveryPromise = null
  retryAfter = 0
}

export const __test = Object.freeze({
  waitForDiscovery,
  request,
  probe,
  validPort,
  ports: PORTS,
  runtimePath: RUNTIME_PATH,
  routingNonceHeader: ROUTING_NONCE_HEADER,
  remoteIdentityPaths,
  secureMarkerPaths,
  isManagedRemoteHost,
  validateRemoteIdentity,
  identityState,
  readRemoteIdentity,
  discoverUncached,
})
