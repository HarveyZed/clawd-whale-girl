// Pure mapping: DeepSeek Harness session events -> Clawd state/event pairs.
// The first four rows are the official bridge's mapping, kept byte-for-byte in behaviour.
// Everything below is added by this fork.

export const OFFICIAL_TYPES = ['turn/start', 'tool/call', 'tool/result', 'turn/end'];

export function mapSessionEvent(event) {
  const type = event?.type;
  if (type === 'turn/start') return { event: 'UserPromptSubmit', state: 'thinking' };
  if (type === 'tool/call') return { event: 'PreToolUse', state: 'working', toolName: event?.data?.name };
  if (type === 'tool/result') {
    const content = event?.data?.message?.content;
    const failed = Boolean(event?.data?.error)
      || (Array.isArray(content) && content.some((item) => item?.isError === true));
    return failed
      ? { event: 'PostToolUseFailure', state: 'error' }
      : { event: 'PostToolUse', state: 'working' };
  }
  if (type === 'turn/end') {
    const rawReason = event?.data?.reason;
    const kind = String(
      rawReason && typeof rawReason === 'object' ? rawReason.kind : rawReason ?? '',
    ).toLowerCase();
    return kind === 'error'
      ? { event: 'StopFailure', state: 'error' }
      : { event: 'Stop', state: 'attention' };
  }
  return null;
}

/** Extra mappings added by this fork. Returns null when the event carries no pet signal. */
export function mapExtraEvent(event) {
  const type = event?.type;
  if (type === 'approval/asked') return { event: 'Notification', state: 'notification' };
  if (type === 'approval/decided') return { event: 'PostToolUse', state: 'working' };
  if (type === 'subagent/descriptor' || type === 'subagent/catalog') {
    return { event: 'SubagentStart', state: 'juggling' };
  }
  if (type === 'team/member' || type === 'team/task'
    || type === 'team/message/queued' || type === 'team/message/delivered') {
    return { event: 'SubagentStart', state: 'juggling' };
  }
  if (type === 'compaction/start') {
    return { event: 'PreCompact', state: 'sweeping' };
  }
  if (type === 'compaction/end') {
    // Real order (verified in a session log): turn/end -> compaction/start ->
    // compaction/summary -> compaction/end. Without this the session stays in
    // 'sweeping' until the next turn, because nothing else follows.
    return { event: 'PostCompact', state: 'idle' };
  }
  if (type === 'compaction/prune') {
    // Bookkeeping only; mapping it to sweeping could re-stick the state after end.
    return null;
  }
  return null;
}

/** A session that runs a subagent: DSH marks the header, and delegationDepth covers resumed children. */
export function isSubagentSession(session) {
  const header = session?.header;
  if (!header) return false;
  return header.origin === 'subagent'
    || (Number.isSafeInteger(header.delegationDepth) && header.delegationDepth > 0);
}

/** Measured surface tokens -> Clawd's context_usage wire shape ({used, limit}). */
export function contextUsagePayload(measure, contextWindow) {
  const used = Number(measure?.surfaceTokens);
  if (!Number.isFinite(used) || used < 0) return null;
  const out = { used: Math.round(used) };
  const limit = Number(contextWindow);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.round(limit);
  return out;
}
