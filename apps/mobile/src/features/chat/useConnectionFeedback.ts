import { useEffect, useState } from 'react';
import type { ConnectionState } from '../../services/session-sync';

/** Presentation grace only. Transport state remains authoritative for sending. */
export function useConnectionFeedback(id: string, state: ConnectionState) {
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const waiting =
    state === 'connecting' || state === 'reconnecting' || state === 'offline';
  useEffect(() => {
    setExpiredFor(null);
    if (!waiting) return;
    const timer = setTimeout(() => setExpiredFor(id), 2000);
    return () => clearTimeout(timer);
  }, [id, waiting]);
  if (!waiting) return state;
  // A slow first handshake is still loading. Escalate only after an actual
  // disconnected/retrying state, and never inherit another session's timer.
  return expiredFor === id && state !== 'connecting' ? 'recovering' : 'loading';
}
