import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import type { Snapshot } from '@pocket/protocol';
import type { Api } from '../../services/api';

/** HTTP acknowledges the command. Only a durable projection settles the UI. */
export function useRunCancellation({
  sessionId,
  api,
  snapshot,
  live,
  retry,
  onError,
}: {
  sessionId: string;
  api?: Pick<Api, 'cancel'>;
  snapshot: Snapshot | null;
  live: boolean;
  retry: () => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const intent = useRef<{
    runId: string;
    key: string;
    inFlight: boolean;
  } | null>(null);
  const latest = useRef({ sessionId, api, snapshot, live, onError, retry });
  latest.current = { sessionId, api, snapshot, live, onError, retry };
  useEffect(() => {
    intent.current = null;
    setPending(null);
    return () => {
      intent.current = null;
    };
  }, [sessionId, api]);
  useEffect(() => {
    const command = intent.current;
    if (!command || snapshot?.session.id !== sessionId) return;
    const run = snapshot.runs.find((item) => item.id === command.runId);
    if (run && run.state !== 'queued' && run.state !== 'running') {
      intent.current = null;
      setPending(null);
      // A lost HTTP response can be confirmed later through replay. Retire its
      // uncertainty feedback when the authoritative outcome becomes known.
      if (!command.inFlight) latest.current.onError('');
    }
  }, [snapshot, pending, sessionId]);
  useEffect(() => {
    if (!pending) return;
    // Recover if the receipt arrives but its stream event is delayed or lost.
    // Reconciliation uses SessionSync, never a competing snapshot/cache writer.
    const timer = setTimeout(() => latest.current.retry(), 5000);
    return () => clearTimeout(timer);
  }, [pending]);
  async function stop(expectedRunId: string) {
    const current = latest.current;
    const run =
      current.snapshot?.session.id === current.sessionId
        ? current.snapshot.runs.find((item) => item.id === expectedRunId)
        : undefined;
    if (
      !current.api ||
      !current.live ||
      !run ||
      (run.state !== 'queued' && run.state !== 'running') ||
      intent.current?.inFlight
    )
      return;
    const command =
      intent.current?.runId === expectedRunId
        ? intent.current
        : { runId: expectedRunId, key: randomUUID(), inFlight: false };
    intent.current = command;
    command.inFlight = true;
    setPending(expectedRunId);
    current.onError('');
    try {
      await current.api.cancel(expectedRunId, command.key);
      // Keep the guard until the terminal projection, including across disconnect.
    } catch {
      if (
        intent.current !== command ||
        latest.current.sessionId !== current.sessionId ||
        latest.current.api !== current.api
      )
        return;
      command.inFlight = false;
      setPending(null);
      latest.current.onError('Stop was not confirmed. Retry when connected.');
      // Retain the command ID for an uncertain delivery retry.
    }
  }
  return { stop, stopping: pending !== null };
}
