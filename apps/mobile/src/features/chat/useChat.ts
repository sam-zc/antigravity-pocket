import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import {
  appSendTextSchema,
  appOrdinaryTextSchema,
  type AppCommand,
  type Message,
} from '@pocket/protocol';
import { useConnection, usePocket } from '../../services/PocketProvider';
import { useRunCancellation } from './useRunCancellation';
import { DraftWriter } from '../../services/draft-writer';
import { latestRun } from '../../services/reducer';
export function useChat(id: string) {
  const { runtime, activate, retry } = usePocket();
  const state = useConnection((s) => s.state);
  const current = useConnection((s) => s.snapshot);
  const snapshot = current?.session.id === id ? current : null;
  const [draft, setDraftState] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyInFlight = useRef(false);
  const [appCommand, setAppCommand] = useState<AppCommand | null>(null);
  const [appPending, setAppPending] = useState<{
    text: string;
    key: string;
  } | null>(null);
  const [appResolving, setAppResolving] = useState(false);
  const external = snapshot?.session.external;
  const denied = state === 'auth-required' || state === 'storage-error';
  const live = useRef(state === 'live');
  live.current = state === 'live';
  const [older, setOlder] = useState<Message[]>([]);
  const [before, setBefore] = useState<number | null | undefined>();
  const pending = useRef<{ text: string; key: string } | null>(null);
  const writer = useMemo(
    () =>
      new DraftWriter(async (text, command) => {
        if (!runtime) throw new Error('Connection required');
        await runtime.cache.saveDraft(id, text, command);
      }),
    [runtime, id],
  );
  const binding = useMemo(
    () => ({ active: true, loaded: false }),
    [runtime, id, denied],
  );
  const sendInFlight = useRef<object | null>(null);
  useFocusEffect(
    useCallback(() => {
      activate(id);
      return () => activate(null);
    }, [id, activate]),
  );
  useEffect(() => {
    let mounted = true;
    binding.active = !denied;
    binding.loaded = false;
    pending.current = null;
    sendInFlight.current = null;
    setSending(false);
    setHistoryLoading(false);
    historyInFlight.current = false;
    setAppCommand(null);
    setAppPending(null);
    setAppResolving(false);
    setLoaded(false);
    setDraftState('');
    setError('');
    setOlder([]);
    setBefore(undefined);
    if (denied) return;
    void runtime?.cache
      .draft(id)
      .then((d) => {
        if (!mounted) return;
        setDraftState(d.text);
        pending.current = d.command ? { text: d.text, key: d.command } : null;
        setAppPending(pending.current);
        if (d.command)
          setError(
            'A previous send was not confirmed. Check its status before submitting again.',
          );
        binding.loaded = true;
        setLoaded(true);
      })
      .catch(() => {
        if (mounted)
          setError(
            'Draft storage unavailable. Retry connection before sending.',
          );
      });
    return () => {
      mounted = false;
      binding.active = false;
    };
  }, [id, runtime, activate, binding, denied]);
  const save = (text: string, key: string | null = null) =>
    writer.save(text, key);
  const setDraft = (text: string) => {
    if (
      !binding.active ||
      !binding.loaded ||
      sendInFlight.current ||
      appPending
    )
      return;
    setDraftState(text);
    if (pending.current?.text !== text) pending.current = null;
    const operation = pending.current
      ? save(text, pending.current.key)
      : writer.edit(text);
    void operation.catch(() =>
      setError('Could not save draft. Keep this screen open and retry.'),
    );
  };
  const run = snapshot?.runs.find(
    (r) => r.state === 'queued' || r.state === 'running',
  );
  async function send(text: string) {
    if (
      !runtime ||
      (external &&
        (!external.send || external.observation !== 'fresh' || appPending)) ||
      sendInFlight.current ||
      state !== 'live' ||
      !binding.active ||
      !binding.loaded ||
      run
    )
      return false;
    if (
      external &&
      !(
        external.send === 'ordinary-text'
          ? appOrdinaryTextSchema
          : appSendTextSchema
      ).safeParse(text).success
    ) {
      setError(
        external.send === 'ordinary-text'
          ? 'Use nonempty ordinary text, at most 2048 UTF-8 bytes.'
          : 'Use: Reply with exactly POCKET-APP-YOUR-MARKER. Text only. Do not use tools, files, commands, or network.',
      );
      return false;
    }
    if (pending.current && pending.current.text !== text) {
      setError(
        'A previous send is unresolved. Keep its original command identity; do not submit replacement text.',
      );
      return false;
    }
    const operation = {};
    sendInFlight.current = operation;
    setSending(true);
    setDraftState(text);
    setError('');
    if (!pending.current || pending.current.text !== text)
      pending.current = { text, key: randomUUID() };
    const command = pending.current;
    try {
      await save(text, command.key);
      if (!binding.active) return false;
      if (external) setAppPending(command);
      if (!live.current) return false;
      if (external) {
        setAppPending(command);
        setAppCommand(null);
        const receipt = await runtime.api.appSend(id, text, command.key);
        if (binding.active && pending.current?.key === command.key)
          setAppCommand((current) =>
            current?.commandId === command.key &&
            current.delivery !== 'received'
              ? current
              : receipt,
          );
        return true; // Receipt only; polling clears the draft only after an acknowledgement.
      }
      await runtime.api.prompt(id, text, command.key);
      if (!binding.active) return false;
      pending.current = null;
      setDraftState('');
      await save('').catch(() =>
        setError('Sent, but could not clear the saved draft.'),
      );
      return true;
    } catch (e) {
      if (!binding.active || (external && pending.current?.key !== command.key))
        return false;
      setError(
        external
          ? 'Delivery uncertain. Check status or resolve without resending.'
          : e instanceof Error
            ? e.message
            : 'Send was not confirmed. Retry uses the same command ID.',
      );
      return false;
    } finally {
      if (sendInFlight.current === operation) {
        sendInFlight.current = null;
        if (binding.active) setSending(false);
      }
    }
  }
  const refreshApp = useCallback(async () => {
    if (
      !runtime ||
      !appPending ||
      !external ||
      !binding.active ||
      !live.current
    )
      return;
    try {
      const receipt = await runtime.api.appCommand(id, appPending.key);
      if (!binding.active || pending.current?.key !== appPending.key) return;
      setAppCommand(receipt);
      setError('');
      if (
        receipt.delivery === 'acknowledged' ||
        receipt.delivery === 'not_sent' ||
        receipt.resolvedAt
      ) {
        const text = receipt.delivery === 'not_sent' ? appPending.text : '';
        await writer.save(text, null);
        if (!binding.active || pending.current?.key !== appPending.key) return;
        pending.current = null;
        setAppPending(null);
        setDraftState(text);
        setError('');
      }
    } catch {
      if (binding.active && pending.current?.key === appPending.key)
        setError('Delivery uncertain. Status checks never resend.');
    }
  }, [runtime, id, appPending, external, binding, writer]);
  useEffect(() => {
    if (!external || !appPending || state !== 'live') return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshApp();
      if (!closed)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [external, appPending, state, refreshApp]);
  async function resolveApp() {
    if (
      !runtime ||
      !appPending ||
      appResolving ||
      state !== 'live' ||
      !external?.send
    )
      return;
    setAppResolving(true);
    try {
      const receipt = await runtime.api.resolveAppCommand(
        id,
        appPending.text,
        appPending.key,
      );
      if (!binding.active || pending.current?.key !== appPending.key) return;
      setAppCommand(receipt);
      await writer.save('', null);
      if (!binding.active || pending.current?.key !== appPending.key) return;
      pending.current = null;
      setAppPending(null);
      setDraftState('');
      setError('');
    } catch {
      if (binding.active)
        setError(
          'Resolution was not confirmed. Check status; no resend occurred.',
        );
    } finally {
      if (binding.active) setAppResolving(false);
    }
  }
  const { stop, stopping } = useRunCancellation({
    sessionId: id,
    api: runtime?.api,
    snapshot,
    live: state === 'live',
    retry,
    onError: setError,
  });
  async function loadOlder() {
    const cursor = before === undefined ? snapshot?.historyBefore : before;
    if (!runtime || !cursor || !binding.active || !live.current) return;
    try {
      const page = await runtime.api.history(id, cursor);
      if (!binding.active) return;
      setOlder((rows) => [...page.items, ...rows].slice(-1000));
      setBefore(page.nextBefore);
    } catch {
      if (binding.active) setError('Could not load earlier messages.');
    }
  }
  async function nextAppHistory() {
    if (
      !runtime ||
      !binding.active ||
      state !== 'live' ||
      external?.view !== 'coding' ||
      external.windowEnd === undefined ||
      historyInFlight.current
    )
      return;
    historyInFlight.current = true;
    setHistoryLoading(true);
    setError('');
    try {
      await runtime.api.nextAppHistory(id, external.windowEnd);
      // Committed external.snapshot arrives through the existing replay/snapshot path.
    } catch {
      if (binding.active)
        setError(
          'Could not load the next bounded window. Check the App connection or desktop owner status; no messages were sent.',
        );
    } finally {
      if (binding.active) {
        historyInFlight.current = false;
        setHistoryLoading(false);
      }
    }
  }
  const messages = (
    denied ? [] : [...older, ...(snapshot?.messages ?? [])]
  ).filter((m, i, all) => all.findIndex((v) => v.id === m.id) === i);
  return {
    nextAppHistory,
    historyLoading,
    appCommand,
    appPending,
    appResolving,
    refreshApp,
    resolveApp,
    state,
    snapshot,
    draft: denied ? '' : draft,
    setDraft,
    loaded,
    sending,
    stopping,
    error,
    run,
    terminal: snapshot ? latestRun(snapshot) : undefined,
    send,
    stop,
    loadOlder,
    messages,
    hasOlder: !!(before === undefined ? snapshot?.historyBefore : before),
    retry,
  };
}
