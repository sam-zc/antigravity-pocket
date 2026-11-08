import type { DurableEvent, Snapshot } from '@pocket/protocol';
export class ResyncError extends Error {}
export function applyEvent(snapshot: Snapshot, event: DurableEvent): Snapshot {
  if (event.streamId !== snapshot.streamId)
    throw new ResyncError('Wrong stream');
  if (event.sequence <= snapshot.through) return snapshot;
  if (event.sequence !== snapshot.through + 1)
    throw new ResyncError('Sequence gap');
  const next = { ...snapshot, through: event.sequence };
  switch (event.type) {
    case 'external.snapshot':
      next.session = event.payload.session;
      next.messages = event.payload.messages;
      next.runs = [];
      next.tools = [];
      next.historyBefore = null;
      break;
    case 'session.created':
      next.session = event.payload;
      break;
    case 'message.started':
      if (snapshot.messages.some((m) => m.id === event.payload.id))
        throw new ResyncError('Duplicate message identity');
      next.messages = [...snapshot.messages, event.payload].slice(-100);
      break;
    case 'message.delta': {
      const p = event.payload;
      const msg = snapshot.messages.find((m) => m.id === p.messageId);
      if (
        !msg ||
        msg.runId !== p.runId ||
        msg.revision !== p.expectedRevision ||
        msg.text.length !== p.startOffset ||
        p.revision !== p.expectedRevision + 1 ||
        msg.status !== 'streaming'
      )
        throw new ResyncError('Delta mismatch');
      next.messages = snapshot.messages.map((m) =>
        m.id === msg.id
          ? { ...m, text: m.text + p.text, revision: p.revision }
          : m,
      );
      break;
    }
    case 'message.completed': {
      const p = event.payload;
      const msg = snapshot.messages.find((m) => m.id === p.messageId);
      if (
        !msg ||
        msg.runId !== p.runId ||
        msg.text.length !== p.length ||
        p.revision !== msg.revision + 1
      )
        throw new ResyncError('Completion mismatch');
      next.messages = snapshot.messages.map((m) =>
        m.id === msg.id ? { ...m, status: p.status, revision: p.revision } : m,
      );
      break;
    }
    case 'agent.status.changed':
    case 'run.terminal':
      next.runs = [
        ...snapshot.runs.filter((r) => r.id !== event.payload.id),
        event.payload,
      ].slice(-100);
      break;
    case 'agent.tool.changed':
      next.tools = [
        ...snapshot.tools.filter((t) => t.id !== event.payload.id),
        event.payload,
      ].slice(-100);
      break;
  }
  return next;
}

// Snapshot run arrays are newest-first, while live upserts append. Message
// ordinals are the stable source of chronology across both paths.
export function latestRun(snapshot: Pick<Snapshot, 'messages' | 'runs'>) {
  const runId = snapshot.messages.at(-1)?.runId;
  return snapshot.runs.find((run) => run.id === runId);
}
