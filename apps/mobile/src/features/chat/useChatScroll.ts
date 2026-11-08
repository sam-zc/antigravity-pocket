import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlatList, NativeScrollEvent } from 'react-native';
import type { Message } from '@pocket/protocol';
import { useTheme } from '../../theme/Theme';

const THRESHOLD = 48;
export function useChatScroll(messages: Message[]) {
  const { reduced } = useTheme();
  const list = useRef<FlatList<Message>>(null);
  const stuck = useRef(true);
  const dragging = useRef(false);
  const frame = useRef(0);
  const metrics = useRef({ height: 0, viewport: 0, top: 0 });
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  const stopGlide = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  useEffect(() => stopGlide, [stopGlide]);
  const latest = useCallback(
    (smooth = true) => {
      stopGlide();
      stuck.current = true;
      dragging.current = false;
      setAway(false);
      setUnread(false);
      if (!smooth || reduced) {
        list.current?.scrollToEnd({ animated: false });
        return;
      }
      const from = metrics.current.top;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 520);
        const eased = 1 - Math.pow(1 - t, 4);
        const end = Math.max(
          0,
          metrics.current.height - metrics.current.viewport,
        );
        list.current?.scrollToOffset({
          offset: from + (end - from) * eased,
          animated: false,
        });
        if (t < 1) frame.current = requestAnimationFrame(step);
        else {
          frame.current = 0;
          // FlatList can have unmeasured cells; its end estimate improves as we glide.
          list.current?.scrollToEnd({ animated: false });
        }
      };
      frame.current = requestAnimationFrame(step);
    },
    [reduced, stopGlide],
  );

  const user = messages.findLast((message) => message.role === 'user');
  const tail = messages.at(-1);
  const previous = useRef({ userId: user?.id, tail });
  useEffect(() => {
    const before = previous.current;
    previous.current = { userId: user?.id, tail };
    // New sends follow; prepended history and layout-only changes do not.
    if (
      user?.id &&
      user.id !== before.userId &&
      (!before.tail || user.ordinal > before.tail.ordinal)
    ) {
      latest();
    } else if (
      !stuck.current &&
      tail?.role === 'assistant' &&
      tail.text &&
      (!before.tail ||
        tail.ordinal > before.tail.ordinal ||
        (tail.id === before.tail.id && tail.text !== before.tail.text))
    ) {
      setUnread(true);
    }
  }, [user?.id, user?.ordinal, tail, latest]);
  useEffect(() => {
    if (reduced && frame.current) latest(false);
  }, [reduced, latest]);

  const onScroll = (event: NativeScrollEvent) => {
    const top = event.contentOffset.y;
    const before = metrics.current;
    const userUp = dragging.current && top < before.top - 1;
    const previousDistance = before.height - before.viewport - before.top;
    metrics.current = {
      height: event.contentSize.height,
      viewport: event.layoutMeasurement.height,
      top,
    };
    if (frame.current) return;
    const distance = metrics.current.height - metrics.current.viewport - top;
    if (userUp) {
      stuck.current = false;
      setAway(distance > THRESHOLD);
    } else if (
      !stuck.current &&
      distance <= THRESHOLD &&
      top > before.top + 1 &&
      distance < previousDistance
    ) {
      // Native remeasurement can briefly shrink the content around a reader.
      // Resume following only after actual movement toward the bottom.
      stuck.current = true;
      setAway(false);
      setUnread(false);
    } else if (!stuck.current) setAway(true);
  };
  const follow = () => {
    if (stuck.current) {
      if (!frame.current) list.current?.scrollToEnd({ animated: false });
    } else {
      const { height, viewport, top } = metrics.current;
      setAway(height - viewport - top > THRESHOLD);
    }
  };
  return {
    list,
    away,
    unread,
    latest,
    onScroll,
    pause: () => {
      stopGlide();
      stuck.current = false;
      dragging.current = false;
    },
    onDrag: () => {
      stopGlide();
      dragging.current = true;
      stuck.current = false;
    },
    onDragEnd: () => {
      dragging.current = false;
    },
    onSize: (_width: number, height: number) => {
      metrics.current.height = height;
      follow();
    },
    onLayout: (height: number) => {
      metrics.current.viewport = height;
      follow();
    },
  };
}
