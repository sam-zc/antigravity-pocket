export type AdapterEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; status: 'running' | 'completed'; summary: string }
  | { type: 'terminal'; outcome: 'completed' | 'failed'; reason?: string };
export interface AgentAdapter {
  readonly id: 'mock';
  readonly version: string;
  run(
    input: { prompt: string; runId: string },
    context: { signal: AbortSignal },
  ): AsyncIterable<AdapterEvent>;
}
