import { setTimeout } from 'node:timers/promises';
import type { AgentAdapter, AdapterEvent } from '@pocket/adapter-sdk';
export class MockAdapter implements AgentAdapter {
  readonly id = 'mock' as const;
  readonly version = '1';
  constructor(private delayMs = 60) {}
  async *run(
    input: { prompt: string; runId: string },
    { signal }: { signal: AbortSignal },
  ): AsyncIterable<AdapterEvent> {
    yield {
      type: 'tool',
      status: 'running',
      summary:
        'Reading a built-in synthetic fixture. No workspace files are accessed.',
    };
    await setTimeout(this.delayMs, undefined, { signal });
    yield {
      type: 'tool',
      status: 'completed',
      summary:
        'Fixture contains 3 example files. No commands or filesystem tools were executed.',
    };
    const answer = `Mock response\n\nYou asked: ${input.prompt.slice(0, 800)}\n\nThis deterministic response travels through HTTP, SQLite and WebSocket replay. The gateway owns this session. No provider, private IDE connection or real workspace was used.\n\nTry disconnecting while I write, then reconnect. Your committed history will still be here.`;
    for (let offset = 0; offset < answer.length; offset += 16) {
      await setTimeout(this.delayMs, undefined, { signal });
      yield { type: 'text', text: answer.slice(offset, offset + 16) };
      if (input.prompt === '/fail' && offset >= 48) {
        yield { type: 'terminal', outcome: 'failed', reason: 'mock_failure' };
        return;
      }
    }
    yield { type: 'terminal', outcome: 'completed' };
  }
}
