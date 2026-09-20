// Clawd on Desk bridge for DeepSeek Harness — extended fork.
//
// Base behaviour (state FIFO + blocking approval bridge) is a fork of Clawd's
// official @dsh-external/dsh-clawd-bridge (MIT, Clawd on Desk). Added here:
//   F1 context usage  -> context_usage on every state post (tokenMeter.measure)
//   F2 approval       -> notification state while an approval is pending
//   F3 subagent/team  -> juggling state
//   F4 compaction     -> sweeping state
//   F5 balance        -> threshold tiers on an isolated virtual session
//
// These F1-F5 tags are the numbering used by the README's 「补了什么」 table.
//
// Boundaries: never post a second sequence for a session the host already
// reports through another plugin; every extra signal rides this plugin's own
// single FIFO per session, so every report for a session has exactly one writer.

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { postState, requestPermission } from './clawd-client.js'

/**
 * Live params file (config.paramsPath). Read at startup and re-read while the host
 * runs, so threshold / mode / refresh can change without restarting dsh web.
 */
export function readParamsFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null
  try {
    const stat = statSync(filePath)
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return { mtimeMs: stat.mtimeMs, data }
  } catch { return null }
}

/** Merge params over the bundle/file config (balance one level deep). */
export function mergeParams(config, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return config
  const out = { ...config, ...params }
  if (params.balance && typeof params.balance === 'object' && !Array.isArray(params.balance)) {
    const base = config.balance && typeof config.balance === 'object' ? config.balance : {}
    out.balance = { ...base, ...params.balance }
  }
  return out
}

/**
 * Copy a normalised config into the object the running plugin already closed over.
 * Keeps balance object identity stable so the watcher's reference stays live.
 */
function applyConfigInto(target, next) {
  const balance = target.balance
  Object.assign(target, next)
  Object.assign(balance, next.balance)
  target.balance = balance
}

/** Editable subset exposed to the Settings -> Plugins tab. */
export function publicConfig(cfg) {
  return {
    contextUsage: cfg.contextUsage,
    approvalNotification: cfg.approvalNotification,
    subagentJuggling: cfg.subagentJuggling,
    compactionSweeping: cfg.compactionSweeping,
    permissionBubble: cfg.permissionBubble,
    contextWindowFallback: cfg.contextWindowFallback,
    balance: { ...cfg.balance },
  }
}

/** Optional file log (config.debugLogPath). Empty path disables it. */
function createDebugLog(filePath) {
  if (typeof filePath !== 'string' || !filePath) return () => {}
  return (message) => {
    try { appendFileSync(filePath, `[${new Date().toISOString()}] ${message}\n`) } catch {}
  }
}
import {
  mapSessionEvent,
  mapExtraEvent,
  isSubagentSession,
  contextUsagePayload,
} from './mapping.js'
import {
  fetchBalance,
  pickBalanceInfo,
  tierFor,
  tierToState,
  balanceLabel,
  TIER_OK,
} from './balance.js'

export const name = 'dsh-clawd-extras'
/** Bumped on every behaviour change so a restart is identifiable in debug.log. */
export const PLUGIN_VERSION = '0.5.3'

/** Package root, so default paths never hard-code a machine layout. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const AGENT_ID = 'deepseek-harness'
const HOOK_SOURCE = 'dsh-plugin'
const SESSION_PREFIX = `${AGENT_ID}:`
const MAX_QUEUE_PER_SESSION = 32
const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const TITLE_MAX = 80
const TEXT_MAX = 500
const BALANCE_SESSION_PREFIX = `${SESSION_PREFIX}balance-guard`
const STICKY_REFRESH_MS = 10000

const CRITICAL_EVENTS = new Set([
  'SessionStart', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd',
])

function boundedText(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  return Array.from(clean).slice(0, max).join('')
}

export function canonicalSessionId(value) {
  const raw = boundedText(value, 200)
  if (!raw) return `${SESSION_PREFIX}default`
  return raw.startsWith(SESSION_PREFIX) ? raw : `${SESSION_PREFIX}${raw}`
}

function sessionFields(session, opts = {}) {
  const rawId = session?.id
  const cwd = boundedText(session?.header?.cwd, 4096)
  const subagent = isSubagentSession(session)
  // Subagent sessions must stay visible to the state merge to drive `juggling`.
  const headless = subagent ? opts.subagentHeadless === true : false
  return {
    session_id: canonicalSessionId(rawId),
    ...(cwd ? { cwd } : {}),
    ...(headless ? { headless: true } : {}),
    ...(subagent ? { recap_is_subagent: true } : {}),
  }
}

export function statePayload(session, mapping, sequence = {}, opts = {}) {
  return {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    agent_pid: process.pid,
    ...sessionFields(session, opts),
    state: mapping.state,
    event: mapping.event,
    ...(mapping.toolName ? { tool_name: boundedText(mapping.toolName, 160) } : {}),
    ...(mapping.title ? { session_title: boundedText(mapping.title, TITLE_MAX) } : {}),
    ...(Number.isSafeInteger(sequence.eventSeq) && sequence.eventSeq >= 0
      ? { event_seq: sequence.eventSeq } : {}),
    ...(Number.isSafeInteger(sequence.sessionSeq) && sequence.sessionSeq >= 0
      ? { session_seq: sequence.sessionSeq } : {}),
    ...(sequence.contextUsage ? { context_usage: sequence.contextUsage } : {}),
  }
}

export function buildApprovalPayload(req) {
  const session = req?.agent?.session
  const rawId = session?.id ?? req?.agent?.id
  const cwd = boundedText(session?.header?.cwd, 4096)
  const callId = boundedText(req?.callId, 200)
  const headless = session?.header?.origin === 'subagent'
  return {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    hook_event_name: 'PermissionRequest',
    session_id: canonicalSessionId(rawId),
    tool_name: boundedText(req?.toolName, 160) || 'unknown',
    tool_use_id: callId || randomUUID(),
    tool_input: {},
    reason: boundedText(req?.reason, TEXT_MAX),
    agent_pid: process.pid,
    ...(cwd ? { cwd } : {}),
    ...(headless ? { headless: true } : {}),
  }
}

export function createStateSender(signal, postStateImpl = postState, onResult = null) {
  const queues = new Map()

  function compact(queue, payload) {
    if (queue.length < MAX_QUEUE_PER_SESSION) { queue.push(payload); return true }
    if (!CRITICAL_EVENTS.has(payload.event)) return false
    const replaceable = queue.findIndex((item) => !CRITICAL_EVENTS.has(item.event))
    if (replaceable !== -1) { queue.splice(replaceable, 1); queue.push(payload); return true }
    let coalescible = -1
    if (payload.event !== 'SessionStart') {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].event === payload.event) { coalescible = index; break }
      }
    }
    if (coalescible === -1) return false
    queue.splice(coalescible, 1); queue.push(payload); return true
  }

  async function drain(sessionId, record) {
    if (record.draining) return
    record.draining = true
    try {
      while (!signal.aborted && record.items.length > 0) {
        const payload = record.items.shift()
        try {
          const result = await postStateImpl(payload, { signal })
          if (onResult) { try { onResult(payload, result) } catch {} }
        } catch { /* best effort */ }
      }
    } finally {
      record.draining = false
      if (record.items.length === 0) queues.delete(sessionId)
    }
  }

  return {
    enqueue(payload) {
      if (signal.aborted || !payload?.session_id) return false
      let record = queues.get(payload.session_id)
      if (!record) { record = { draining: false, items: [] }; queues.set(payload.session_id, record) }
      const accepted = compact(record.items, payload)
      if (accepted) void drain(payload.session_id, record)
      return accepted
    },
    clear() { queues.clear() },
  }
}

function linkAbortSignals(signals) {
  const controller = new AbortController()
  const listeners = []
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (!signal || typeof signal.addEventListener !== 'function') continue
    if (signal.aborted) { abort(); break }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(signal)
  }
  return {
    signal: controller.signal,
    cleanup() { for (const signal of listeners) signal.removeEventListener('abort', abort) },
  }
}

export function createApprovalHandler(
  requestPermissionImpl = requestPermission,
  permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
  lifetimeSignal = null,
) {
  return async (req, next) => {
    if (req?.signal?.aborted) return 'cancelled'
    if (lifetimeSignal?.aborted) return next()
    const linked = linkAbortSignals([req?.signal, lifetimeSignal])
    let answer
    try {
      answer = await requestPermissionImpl(buildApprovalPayload(req), {
        signal: linked.signal, timeoutMs: permissionTimeoutMs,
      })
    } catch { answer = { kind: 'no-decision' } } finally { linked.cleanup() }
    if (req?.signal?.aborted) return 'cancelled'
    if (lifetimeSignal?.aborted) return next()
    if (answer?.kind === 'cancelled') return 'cancelled'
    if (answer?.kind === 'decision') return answer.decision === 'allow' ? 'allowed-once' : 'rejected'
    return next()
  }
}

// ── F5: isolated virtual session for balance alerts ──────────────────────────
export function createVirtualSession(sessionId, initialTitle = '', startAt = Math.floor(Date.now() / 1000)) {
  // Two Clawd-side fence rules shape this helper:
  //   1. the fence OUTLIVES this plugin process, so the watermark must never rewind;
  //   2. a SessionStart on a session the fence still considers ACTIVE is rejected as
  //      'active-session-restart'. A run that dies before its SessionEnd is accepted
  //      would therefore block every later run that reuses the same id.
  // Unique-per-run ids + a wall-clock watermark make both impossible.
  let counter = Number.isSafeInteger(startAt) && startAt > 0 ? startAt : 1
  let title = initialTitle
  const base = { agent_id: AGENT_ID, hook_source: HOOK_SOURCE, agent_pid: process.pid, session_id: sessionId }
  const withTitle = () => (title ? { ...base, session_title: boundedText(title, TITLE_MAX) } : base)
  return {
    id: sessionId,
    setTitle(value) { title = typeof value === 'string' ? value : '' },
    start() { return { ...withTitle(), event: 'SessionStart', state: 'idle', session_seq: counter++ } },
    state(state, event) { return { ...withTitle(), event, state, event_seq: counter++ } },
    end() { return { ...withTitle(), event: 'SessionEnd', state: 'sleeping', session_seq: counter++ } },
    // Intentionally no reset(): rewinding the counter breaks Clawd's fence.
  }
}

function normalizeBalanceConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const mode = cfg.mode === 'sticky' ? 'sticky' : 'flash'
  return {
    enabled: cfg.enabled !== false,
    threshold: Number.isFinite(Number(cfg.threshold)) ? Number(cfg.threshold) : 20,
    currency: typeof cfg.currency === 'string' && cfg.currency ? cfg.currency : 'CNY',
    apiKeyEnv: typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv ? cfg.apiKeyEnv : 'DEEPSEEK_API_KEY',
    baseUrl: typeof cfg.baseUrl === 'string' && cfg.baseUrl ? cfg.baseUrl : 'https://api.deepseek.com',
    endpoint: typeof cfg.endpoint === 'string' && cfg.endpoint ? cfg.endpoint : '/user/balance',
    refreshMs: Number.isFinite(cfg.refreshMs) && cfg.refreshMs >= 60000 ? cfg.refreshMs : 300000,
    // Until the first successful poll (the credentials service may not be injected yet at startup).
    firstRetryMs: Number.isFinite(cfg.firstRetryMs) && cfg.firstRetryMs >= 1000 ? cfg.firstRetryMs : 15000,
    mode,
    flashMs: Number.isFinite(cfg.flashMs) && cfg.flashMs > 0 ? cfg.flashMs : 12000,
    remindEveryMs: Number.isFinite(cfg.remindEveryMs) && cfg.remindEveryMs > 0 ? cfg.remindEveryMs : 1800000,
  }
}

async function resolveApiKey(credentials, envName) {
  try {
    if (credentials && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(envName)
      const value = resolved && typeof resolved === 'object' ? resolved.value : resolved
      if (typeof value === 'string' && value) return value
    }
  } catch { /* fall through to env */ }
  const env = process.env?.[envName]
  return typeof env === 'string' && env ? env : null
}

function startBalanceWatcher({ ctx, sender, cfg, generation, getCredentials, log, debug = () => {}, fetchBalanceImpl = fetchBalance }) {
  if (!cfg.enabled) return
  // Unique per run: a previous run that never got its SessionEnd accepted must not
  // block this one (see createVirtualSession).
  const session = createVirtualSession(`${BALANCE_SESSION_PREFIX}-${Math.floor(Date.now() / 1000)}`, '余额')
  let lastTier = TIER_OK
  let lastFlashAt = 0
  let started = false
  let closingTimer = null
  let stickyTimer = null
  let busy = false

  const logLine = (msg) => { try { log && log(msg) } catch {} }

  function closeSession() {
    if (!started) return
    started = false
    sender.enqueue(session.end())
    // counter stays monotonic on purpose (see createVirtualSession)
  }

  function clearTimers() {
    if (closingTimer) { clearTimeout(closingTimer); closingTimer = null }
    if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null }
  }

  function show(tier, label) {
    session.setTitle(label)   // HUD row carries the amount, not just "余额"
    if (!started) { sender.enqueue(session.start()); started = true }
    const mapped = tierToState(tier)
    if (!mapped) return
    sender.enqueue(session.state(mapped.state, mapped.event))
    logLine(`balance ${tier} -> ${mapped.state} (${label})`)
    debug(`balance alert posted: session=${session.id} state=${mapped.state} title="${label}"`)
    if (cfg.mode === 'flash') {
      if (closingTimer) clearTimeout(closingTimer)
      closingTimer = setTimeout(() => { closingTimer = null; closeSession() }, cfg.flashMs)
    } else if (!stickyTimer) {
      const tick = () => {
        stickyTimer = null
        if (!started) return
        sender.enqueue(session.state(mapped.state, mapped.event))
        stickyTimer = setTimeout(tick, STICKY_REFRESH_MS)
      }
      stickyTimer = setTimeout(tick, STICKY_REFRESH_MS)
    }
  }

  async function poll() {
    if (busy || generation.signal.aborted) return
    busy = true
    try {
      const apiKey = await resolveApiKey(getCredentials(), cfg.apiKeyEnv)
      if (!apiKey) { logLine(`balance: no credential ${cfg.apiKeyEnv}`); debug(`balance: no credential ${cfg.apiKeyEnv}`); return }
      const data = await fetchBalanceImpl({
        baseUrl: cfg.baseUrl, endpoint: cfg.endpoint, apiKey, timeoutMs: 10000,
      })
      const info = pickBalanceInfo(data && data.balance_infos, cfg.currency)
      const amount = Number(info && info.total_balance)
      const tier = data && data.is_available === false ? 'critical' : tierFor(amount, cfg.threshold)
      const label = balanceLabel(info)
      debug(`balance poll: available=${data?.is_available} amount=${info?.total_balance} ${info?.currency} threshold=${cfg.threshold} tier=${tier} label="${label}"`)
      const now = Date.now()
      const crossed = tier !== lastTier
      const shouldRemind = tier !== TIER_OK && cfg.remindEveryMs > 0
        && now - lastFlashAt >= cfg.remindEveryMs
      if (tier === TIER_OK) {
        clearTimers()
        closeSession()
      } else if (crossed || shouldRemind) {
        clearTimers()
        lastFlashAt = now
        show(tier, label)
      }
      if (crossed) logLine(`balance tier ${lastTier} -> ${tier} (${label})`)
      lastTier = tier
      sawSuccess = true
    } catch (error) {
      logLine(`balance poll failed: ${error && error.message}`)
    } finally { busy = false }
  }

  // Self-scheduling: a first poll that fails to resolve credentials retries soon
  // instead of waiting a whole refresh interval.
  let timer = null
  let sawSuccess = false
  let stopped = false
  function schedule(delay) {
    if (stopped || generation.signal.aborted) return
    timer = setTimeout(() => { timer = null; void runOnce() }, delay)
  }
  async function runOnce() {
    await poll()
    if (stopped || generation.signal.aborted) return
    schedule(sawSuccess ? cfg.refreshMs : cfg.firstRetryMs)
  }
  ctx.effect(() => {
    void runOnce()
    return () => { stopped = true; if (timer) clearTimeout(timer); clearTimers() }
  }, 'dsh-clawd-extras: balance watcher')
  return {
    kick() {
      if (stopped) return
      if (timer) { clearTimeout(timer); timer = null }
      void runOnce()
    },
  }
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    contextUsage: cfg.contextUsage !== false,
    approvalNotification: cfg.approvalNotification !== false,
    subagentJuggling: cfg.subagentJuggling !== false,
    compactionSweeping: cfg.compactionSweeping !== false,
    permissionBubble: cfg.permissionBubble !== false,
    // Used until the session's own request/context event arrives.
    contextWindowFallback: Number.isFinite(Number(cfg.contextWindowFallback)) && Number(cfg.contextWindowFallback) > 0
      ? Number(cfg.contextWindowFallback)
      : 1000000,
    balance: normalizeBalanceConfig(cfg.balance),
  }
}

export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== 'function' || typeof ctx.inject !== 'function'
    || typeof ctx.effect !== 'function') return
  // undefined -> default inside the package; explicit '' -> disabled (used by tests).
  const debugLogPath = typeof config.debugLogPath === 'string'
    ? config.debugLogPath.trim()
    : join(PACKAGE_ROOT, 'debug.log')
  const paramsPath = typeof config.paramsPath === 'string'
    ? config.paramsPath.trim()
    : join(PACKAGE_ROOT, 'params.json')
  const paramsSnap = readParamsFile(paramsPath)
  const cfg = normalizeConfig(mergeParams(config, paramsSnap ? paramsSnap.data : null))
  const generation = new AbortController()
  // Test-only seams: they let unit tests observe payloads without touching Clawd.
  const postStateImpl = typeof config.testPostState === 'function' ? config.testPostState : postState
  const requestPermissionImpl = typeof config.testRequestPermission === 'function'
    ? config.testRequestPermission
    : requestPermission
  const fetchBalanceImpl = typeof config.testFetchBalance === 'function'
    ? config.testFetchBalance
    : fetchBalance
  const sender = createStateSender(generation.signal, postStateImpl, (payload, result) => {
    // Surface rejections: 204 means Clawd dropped the post (gate/fence/validation).
    if (result && result.ok === false) {
      debug(`post rejected: ${payload.event} reason=${result.reason || '?'} status=${result.statusCode || '-'}`)
    } else if (result && result.statusCode === 204) {
      debug(`post dropped (204): ${payload.event}`)
    }
  })
  const debug = createDebugLog(debugLogPath)
  const lastLogged = new Map()
  debug(`dsh-clawd-extras v${PLUGIN_VERSION} starting | debugLogPath=${config.debugLogPath ? 'on' : 'off'}`
    + ` | contextUsage=${cfg.contextUsage} windowFallback=${cfg.contextWindowFallback}`
    + ` | approval=${cfg.approvalNotification} subagent=${cfg.subagentJuggling} compaction=${cfg.compactionSweeping}`
    + ` | permissionBubble=${cfg.permissionBubble} balance=${cfg.balance.enabled}`
    + ` threshold=${cfg.balance.threshold} mode=${cfg.balance.mode} refreshMs=${cfg.balance.refreshMs} firstRetryMs=${cfg.balance.firstRetryMs}` )
  const permissionTimeoutMs = Number.isFinite(config.permissionTimeoutMs)
    ? Math.max(1000, config.permissionTimeoutMs)
    : DEFAULT_PERMISSION_TIMEOUT_MS

  let tokenMeter = null
  let credentials = null
  let balanceKick = null
  ctx.inject(['tokenMeter'], (injected) => { tokenMeter = injected.tokenMeter })
  ctx.inject(['credentials'], (injected) => {
    credentials = injected.credentials
    debug(`credentials ready: resolve=${typeof credentials?.resolve === 'function'}`)
    // Startup may poll before this callback fires; retry immediately once it does.
    if (balanceKick) { try { balanceKick() } catch {} }
  })

  const contextWindows = new Map()

  const safely = (work) => (...args) => {
    if (generation.signal.aborted) return
    try { work(...args) } catch { /* observers must never throw into DSH */ }
  }

  function usageFor(session) {
    if (!cfg.contextUsage || !tokenMeter || typeof tokenMeter.measure !== 'function') return null
    try {
      const measured = tokenMeter.measure(session)
      return contextUsagePayload(measured, contextWindows.get(session?.id) ?? cfg.contextWindowFallback)
    } catch { return null }
  }

  function mappingFor(session, event) {
    if (cfg.subagentJuggling && isSubagentSession(session)) {
      return { event: 'SubagentStart', state: 'juggling' }
    }
    const base = mapSessionEvent(event)
    if (base) return base
    if (!event) return null
    const extra = mapExtraEvent(event)
    if (!extra) return null
    if (!cfg.approvalNotification && extra.state === 'notification') return null
    if (!cfg.compactionSweeping && extra.state === 'sweeping') return null
    if (!cfg.subagentJuggling && extra.state === 'juggling') return null
    return extra
  }

  ctx.on('session/created', safely((session) => {
    const mapping = cfg.subagentJuggling && isSubagentSession(session)
      ? { event: 'SubagentStart', state: 'juggling' }
      : { event: 'SessionStart', state: 'idle' }
    sender.enqueue(statePayload(session, mapping, { sessionSeq: session?.seq }))
  }))

  ctx.on('session/event', safely((session, event) => {
    if (event?.type === 'request/context') {
      const window = event?.data?.contextWindow
      if (Number.isFinite(window) && window > 0 && session?.id) {
        if (contextWindows.get(session.id) !== window) {
          debug(`request/context received: sid=${canonicalSessionId(session.id)} contextWindow=${window}`)
        }
        contextWindows.set(session.id, window)
      }
    }
    const mapping = mappingFor(session, event)
    if (!mapping) return
    const contextUsage = usageFor(session)
    sender.enqueue(statePayload(session, mapping, {
      eventSeq: event?.seq,
      contextUsage,
    }))
    // Sampled audit line: one per state change per session (verification + debugging).
    const key = `${mapping.state}/${mapping.event}`
    if (lastLogged.get(session?.id) !== key) {
      lastLogged.set(session?.id, key)
      debug(`post sid=${canonicalSessionId(session?.id)} state=${mapping.state} event=${mapping.event}`
        + ` ctx=${contextUsage ? `${contextUsage.used}/${contextUsage.limit ?? '?'}` : 'none'}`
        + ` headless=${isSubagentSession(session) ? 'false(subagent)' : 'false'}`)
    }
  }))

  ctx.on('session/disposed', safely((session) => {
    contextWindows.delete(session?.id)
    sender.enqueue(statePayload(session, { event: 'SessionEnd', state: 'sleeping' }, {
      sessionSeq: session?.seq,
    }))
  }))

  if (cfg.permissionBubble) {
    ctx.inject(['approval'], (approvalCtx) => {
      if (!approvalCtx || typeof approvalCtx.on !== 'function') return
      approvalCtx.on(
        'approval/request',
        createApprovalHandler(requestPermissionImpl, permissionTimeoutMs, generation.signal),
        { prepend: true },
      )
    })
  }

  const balanceWatcher = startBalanceWatcher({
    ctx,
    sender,
    cfg: cfg.balance,
    generation,
    getCredentials: () => credentials,
    debug,
    fetchBalanceImpl,
    log: (message) => { try { ctx.logger?.info?.(`[clawd-extras] ${message}`) } catch {} },
  })
  if (balanceWatcher && typeof balanceWatcher.kick === 'function') balanceKick = balanceWatcher.kick

  // Live params: re-read the file every few seconds and mutate the config the
  // running handlers already closed over (no restart needed).
  if (paramsPath) {
    ctx.effect(() => {
      let last = paramsSnap ? paramsSnap.mtimeMs : 0
      const timer = setInterval(() => {
        const snap = readParamsFile(paramsPath)
        if (!snap || snap.mtimeMs === last) return
        last = snap.mtimeMs
        applyConfigInto(cfg, normalizeConfig(mergeParams(config, snap.data)))
        debug(`params reloaded from ${paramsPath}: ${JSON.stringify(snap.data)}`)
        if (balanceKick) { try { balanceKick() } catch {} }
      }, Number.isFinite(Number(config.paramsPollMs)) && Number(config.paramsPollMs) >= 100
        ? Number(config.paramsPollMs)
        : 3000)
      return () => clearInterval(timer)
    }, 'dsh-clawd-extras: params watcher')
  }

  // Settings -> Plugins tab data path (browser half fetches /clawd-extras/params).
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx && webCtx.webServer
    if (!server || typeof server.register !== 'function') return
    const send = (res, code, body, method) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(method === 'HEAD' ? undefined : JSON.stringify(body))
    }
    server.register({
      kind: 'exact',
      path: '/dsh-clawd-extras/params',
      handler: async (req, res) => {
        const method = req.method || 'GET'
        try {
          if (method === 'GET' || method === 'HEAD') return send(res, 200, publicConfig(cfg), method)
          if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, method)
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 64 * 1024) return send(res, 413, { error: 'body too large' }, method)
          }
          const patch = JSON.parse(body || '{}')
          applyConfigInto(cfg, normalizeConfig(mergeParams(config, patch)))
          let persisted = false
          if (paramsPath) {
            try {
              writeFileSync(paramsPath, JSON.stringify(publicConfig(cfg), null, 2) + '\n')
              persisted = true
            } catch { /* keep the in-memory change */ }
          }
          debug(`settings tab update: ${JSON.stringify(patch)} persisted=${persisted}`)
          if (balanceKick) { try { balanceKick() } catch {} }
          return send(res, 200, { ok: true, persisted, config: publicConfig(cfg) }, method)
        } catch (error) {
          return send(res, 400, { error: String((error && error.message) || error) }, method)
        }
      },
    })
  })

  ctx.effect(() => () => {
    generation.abort()
    sender.clear()
  }, 'dsh-clawd-extras: lifetime')
}
