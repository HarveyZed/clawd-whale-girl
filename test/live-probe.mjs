// Live probe: is the Clawd SSH-host transport actually reachable right now?
//
// Run this on the DSH host whenever "the pet shows nothing"
// needs to be diagnosed. It distinguishes the three failure modes that look
// identical from the desk app's side:
//
//   0. identity unusable            -> half-deployed / corrupt identity (fail closed)
//   1. no reverse forward bound yet  -> the app's SSH host session is not up
//   2. reverse forward up, nonce bad -> identity file stale / redeployed
//   3. everything fine               -> the desk app is reachable
//
// Usage: node test/live-probe.mjs
import { __test } from '../lib/clawd-client.js'

const state = await __test.identityState()
console.log('identity candidates:')
for (const filePath of __test.remoteIdentityPaths()) {
  let fileState = 'missing'
  try {
    const { readFile } = await import('node:fs/promises')
    JSON.parse(await readFile(filePath, 'utf8'))
    fileState = 'present'
  } catch {}
  console.log(`  [${fileState === 'present' ? 'x' : ' '}] ${filePath}`)
}

if (state.status !== 'valid') {
  if (state.status === 'invalid') {
    console.log('\nRESULT: identity is present but unusable (' + state.reason + ') at ' + (state.filePath || '<managed remote, no file>'))
    console.log('        -> fail closed: the bridge reports "clawd-unavailable" and will NOT scan local ports.')
    console.log('        -> re-pair the SSH host in Clawd, or delete the stale identity file if this host is no longer a remote.')
    process.exit(5)
  }
  console.log('\nRESULT: this host has no readable clawd-remote.json -> Clawd never deployed an SSH host session here, or the deploy is not finished.')
  console.log('        The bridge will stay at "clawd-unavailable" until the app pairs this host.')
  process.exit(1)
}
const identity = state.identity

console.log(`\nremote identity: port=${identity.remotePort} profile=${identity.profileId} deployed=${new Date(identity.deployedAt).toISOString()}`)
console.log(`nonce: ${identity.routingNonce.slice(0, 8)}… (32 hex chars)`)

const probe = await __test.request(identity.remotePort, 'GET', '/state', undefined, {
  timeoutMs: 3000,
  maxResponseBytes: 4096,
  nonce: identity.routingNonce,
})
if (probe.ok) {
  console.log(`\nRESULT: OK — desk app answered ${probe.statusCode} ${String(probe.body || '').slice(0, 120)}`)
  process.exit(0)
}
if (probe.reason === 'request-error') {
  console.log('\nRESULT: nothing is listening on 127.0.0.1:' + identity.remotePort)
  console.log('        -> the app\'s reverse forward is down. Open/keep the Clawd SSH host session connected, then re-run.')
  process.exit(2)
}
if (probe.statusCode === 404) {
  console.log('\nRESULT: 404 from the Clawd ingress — the routing nonce no longer matches (the app redeployed this host).')
  console.log('        -> re-read the identity file; if it still has the old nonce, re-pair the SSH host in Clawd.')
  process.exit(3)
}
console.log(`\nRESULT: unexpected — reason=${probe.reason} status=${probe.statusCode}`)
process.exit(4)
