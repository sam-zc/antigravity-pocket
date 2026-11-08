import { useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import { DraftWriter } from '../../services/draft-writer';
import { usePocket } from '../../services/PocketProvider';
const NEW_DRAFT = 'new-conversation';
export function useNewChat(onOpen: (id: string) => void) {
  const { runtime } = usePocket();
  const query = useQueryClient();
  const [draft, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const key = useRef<string | null>(null);
  const flight = useRef<object | null>(null);
  const binding = useMemo(() => ({ active: true, loaded: false }), [runtime]);
  const writer = useMemo(
    () =>
      new DraftWriter(async (text, command) => {
        if (!runtime) throw new Error('Connection required');
        await runtime.cache.saveDraft(NEW_DRAFT, text, command);
      }),
    [runtime],
  );
  useEffect(() => {
    let current = true;
    binding.active = true;
    binding.loaded = false;
    flight.current = null;
    key.current = null;
    setBusy(false);
    setLoaded(false);
    setValue('');
    void runtime?.cache
      .draft(NEW_DRAFT)
      .then((saved) => {
        if (current) {
          setValue(saved.text);
          key.current = saved.command;
          binding.loaded = true;
          setLoaded(true);
        }
      })
      .catch(() =>
        setError('Draft storage is unavailable. Reconnect before sending.'),
      );
    return () => {
      current = false;
      binding.active = false;
    };
  }, [runtime, binding]);
  const change = (text: string) => {
    if (!binding.active || !binding.loaded || flight.current) return;
    setValue(text);
    key.current = null;
    void writer
      .edit(text)
      .catch(() =>
        setError('Could not save your draft. Retry before leaving.'),
      );
  };
  const send = async (text: string) => {
    if (!runtime || flight.current || !binding.active || !binding.loaded)
      return;
    const operation = {};
    flight.current = operation;
    setBusy(true);
    setError('');
    const command = key.current ?? randomUUID();
    key.current = command;
    try {
      await writer.save(text, command);
      if (!binding.active) return;
      const receipt = await runtime.api.create(
        text.trim().slice(0, 60),
        command,
      );
      if (!binding.active) return;
      const promptKey = randomUUID();
      await runtime.cache.saveDraft(receipt.sessionId, text, promptKey);
      await writer.save('');
      if (!binding.active) return;
      key.current = null;
      setValue('');
      try {
        await runtime.api.prompt(receipt.sessionId, text, promptKey);
        if (!binding.active) return;
        await runtime.cache.saveDraft(receipt.sessionId, '');
      } catch {
        // The chat loads the durable pending key and shows explicit retry guidance.
        // Never automatically resubmit an ambiguous command or erase its draft.
      }
      if (!binding.active) return;
      void query.invalidateQueries({ queryKey: ['sessions'] });
      onOpen(receipt.sessionId);
    } catch {
      if (!binding.active) return;
      setError(
        'Could not start the conversation. Your draft is retained; retry safely.',
      );
    } finally {
      if (flight.current === operation) {
        flight.current = null;
        if (binding.active) setBusy(false);
      }
    }
  };
  return { draft, change, send, busy, loaded, error };
}
