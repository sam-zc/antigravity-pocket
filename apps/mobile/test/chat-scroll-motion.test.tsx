import { act, renderHook } from '@testing-library/react-native';
import { themes } from '@pocket/design-tokens';
import * as theme from '../src/theme/Theme';
import { useChatScroll } from '../src/features/chat/useChatScroll';

it('chases the growing bottom during a glide and stops immediately on a reader drag', async () => {
  const callbacks = new Map<number, (time: number) => void>();
  let id = 0;
  const request = jest
    .spyOn(global, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      callbacks.set(++id, callback);
      return id;
    });
  const cancel = jest
    .spyOn(global, 'cancelAnimationFrame')
    .mockImplementation((key) => {
      if (key != null) callbacks.delete(key);
    });
  const now = jest.spyOn(performance, 'now').mockReturnValue(0);
  const context = jest.spyOn(theme, 'useTheme').mockReturnValue({
    colors: themes.light,
    dark: false,
    preference: 'light',
    setPreference: jest.fn(),
    reduced: false,
  });
  try {
    const { result, unmount } = await renderHook(() => useChatScroll([]));
    const offset = jest.fn();
    const end = jest.fn();
    Object.assign(result.current.list, {
      current: { scrollToOffset: offset, scrollToEnd: end },
    });
    await act(() => {
      result.current.onScroll({
        contentOffset: { x: 0, y: 400 },
        contentSize: { width: 400, height: 1800 },
        layoutMeasurement: { width: 400, height: 600 },
        contentInset: { top: 0, bottom: 0, left: 0, right: 0 },
        zoomScale: 1,
      });
      result.current.latest();
    });
    async function tick(time: number) {
      const next = callbacks.entries().next().value!;
      callbacks.delete(next[0]);
      await act(() => next[1](time));
    }
    await tick(260);
    expect(offset).toHaveBeenLastCalledWith({ offset: 1150, animated: false });
    await act(() => result.current.onSize(400, 2200));
    await tick(390);
    expect(offset.mock.calls.at(-1)?.[0].offset).toBeGreaterThan(1500);
    await act(() => result.current.onDrag());
    expect(callbacks.size).toBe(0);
    const calls = offset.mock.calls.length;
    await act(() => result.current.onSize(400, 2600));
    expect(offset).toHaveBeenCalledTimes(calls);
    expect(end).not.toHaveBeenCalled();
    expect(result.current.away).toBe(true);
    await unmount();
    expect(callbacks.size).toBe(0);
  } finally {
    request.mockRestore();
    cancel.mockRestore();
    now.mockRestore();
    context.mockRestore();
  }
});
