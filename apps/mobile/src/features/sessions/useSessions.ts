import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { usePocket } from '../../services/PocketProvider';
export function useSessions() {
  const { runtime } = usePocket();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['sessions', runtime?.gatewayId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => runtime!.api.sessions(pageParam),
    enabled: !!runtime,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const command = useRef<{ title: string; key: string } | null>(null);
  const create = useCallback(
    async (title: string) => {
      if (!runtime || creating) return null;
      setCreating(true);
      setError('');
      if (!command.current || command.current.title !== title)
        command.current = { title, key: randomUUID() };
      try {
        const receipt = await runtime.api.create(title, command.current.key);
        command.current = null;
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        return receipt.sessionId;
      } catch {
        setError(
          'Session creation was not confirmed. Retry with the same title to safely recover the receipt.',
        );
        return null;
      } finally {
        setCreating(false);
      }
    },
    [runtime, creating, queryClient],
  );
  return {
    ...query,
    sessions: query.data?.pages.flatMap((p) => p.items) ?? [],
    create,
    creating,
    createError: error,
  };
}
