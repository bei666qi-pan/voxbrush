import { Op } from '../engine/types';

export interface AgentResult { ops: Op[]; reply?: string; llmMs?: number; model?: string; error?: string; }

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
