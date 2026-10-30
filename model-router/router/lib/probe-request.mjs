// A request shaped like what Claude Code sends an unrecognized model, so a test
// call meets the same fields a real one does. The two constants are copied from
// docs/model-router-verification.md ("Captured request shape"); refresh them when
// Claude Code changes what it sends.
export const PROBE_BETA = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,effort-2025-11-24'
export const PROBE_CONTEXT_MANAGEMENT = {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}

export const PROBE_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': PROBE_BETA,
  'content-type': 'application/json',
}

export function probeRequest(model) {
  return {
    model,
    max_tokens: 32000,
    stream: false,
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: PROBE_CONTEXT_MANAGEMENT,
    output_config: { effort: 'high' },
    metadata: { user_id: 'model-router-probe' },
    system: [{ type: 'text', text: 'You are a connectivity probe. Reply with OK.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  }
}
