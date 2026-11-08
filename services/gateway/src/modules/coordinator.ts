import type { AgentAdapter } from '@pocket/adapter-sdk';
import { Store } from '../db/store.js';
export class Coordinator {
  private running = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private stopped = false;
  constructor(
    private store: Store,
    private adapter: AgentAdapter,
  ) {}
  kick() {
    if (this.stopped) return;
    for (const run of this.store.queued()) {
      if (this.running.size >= 2) break;
      const user = this.store.start(run.id);
      if (!user) continue;
      const controller = new AbortController();
      const task = this.execute(run.id, user.text, controller).finally(() => {
        this.running.delete(run.id);
        this.kick();
      });
      this.running.set(run.id, { controller, task });
    }
  }
  private async execute(
    runId: string,
    prompt: string,
    controller: AbortController,
  ) {
    const timeout = setTimeout(() => controller.abort(), 120000);
    let terminal = false;
    try {
      for await (const event of this.adapter.run(
        { runId, prompt },
        { signal: controller.signal },
      )) {
        if (controller.signal.aborted) break;
        if (event.type === 'text') this.store.delta(runId, event.text);
        else if (event.type === 'tool')
          this.store.tool(runId, event.status, event.summary);
        else {
          this.store.finish(runId, event.outcome, event.reason ?? null);
          terminal = true;
          break;
        }
      }
      if (!terminal && !this.stopped)
        this.store.finish(
          runId,
          'failed',
          controller.signal.aborted ? 'deadline' : 'missing_terminal',
        );
    } catch {
      // Raw provider/driver errors never enter client responses or logs.
      if (!this.stopped)
        this.store.finish(
          runId,
          'failed',
          controller.signal.aborted ? 'deadline' : 'adapter_error',
        );
    } finally {
      clearTimeout(timeout);
    }
  }
  cancel(runId: string) {
    this.store.finish(runId, 'cancelled', 'user_cancelled');
    this.running.get(runId)?.controller.abort();
    this.kick();
  }
  async close() {
    this.stopped = true;
    for (const entry of this.running.values()) entry.controller.abort();
    await Promise.all([...this.running.values()].map((entry) => entry.task));
  }
}
