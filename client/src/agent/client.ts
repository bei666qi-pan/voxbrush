import { HistoryEntry, Op } from '../engine/types';

export interface AgentResult { ops: Op[]; reply?: string; llmMs?: number; model?: string; error?: string; }

export interface StreamEvent {
  type: 'op' | 'done' | 'error';
  op?: Op; ops?: Op[]; emitted?: number; reply?: string; llmMs?: number; model?: string; message?: string; t?: number;
}

/** v1.1 流式拆解：每解析出一个完整 op 立即回调，实现逐笔绘制 */
export async function callAgentStream(
  text: string, scene: unknown[], snapshot: string | undefined,
  onEvent: (ev: StreamEvent) => void | Promise<void>,
  history?: HistoryEntry[],
): Promise<void> {
  const res = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, scene, snapshot, history }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: `HTTP ${res.status}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const m = p.match(/^data:\s*(.*)$/s);
      if (!m) continue;
      try { const r = onEvent(JSON.parse(m[1]) as StreamEvent); if (r && typeof (r as Promise<void>).then === 'function') await r; } catch { /* ignore */ }
    }
  }
}

export async function callAgent(text: string, scene: unknown[], snapshot?: string): Promise<AgentResult> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, scene, snapshot }),
    signal: AbortSignal.timeout(35000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ops: [], error: json.error ?? `HTTP ${res.status}` };
  return json as AgentResult;
}
