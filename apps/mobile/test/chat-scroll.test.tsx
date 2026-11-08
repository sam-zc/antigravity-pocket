import React from 'react';
import { FlatList } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { Message } from '@pocket/protocol';
import { MessageTimeline } from '../src/features/chat/MessageTimeline';
const answer: Message = {
  id: 'answer',
  sessionId: 'session',
  runId: 'run',
  ordinal: 2,
  role: 'assistant',
  status: 'streaming',
  revision: 1,
  text: 'First words',
};
const prompt: Message = {
  ...answer,
  id: 'prompt',
  ordinal: 1,
  role: 'user',
  status: 'completed',
  text: 'Question',
};
const props = { streaming: true, hasOlder: false, onOlder: jest.fn() };
const timeline = (messages = [prompt, answer], streaming = true) => (
  <MessageTimeline {...props} messages={messages} streaming={streaming} />
);
async function scroll(top: number) {
  await fireEvent.scroll(screen.getByLabelText('Conversation'), {
    nativeEvent: {
      contentSize: { height: 1800, width: 400 },
      layoutMeasurement: { height: 600, width: 400 },
      contentOffset: { x: 0, y: top },
    },
  });
}
async function readEarlier() {
  await scroll(1200);
  await fireEvent(screen.getByLabelText('Conversation'), 'scrollBeginDrag');
  await scroll(400);
  await fireEvent(screen.getByLabelText('Conversation'), 'scrollEndDrag', {
    nativeEvent: { velocity: { x: 0, y: 0 } },
  });
}
it('uses arrow, Writing and New reply states, then returns to following on press', async () => {
  const end = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  const view = await render(timeline());
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  await readEarlier();
  expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  const changed = { ...answer, text: 'First words and more', revision: 2 };
  await view.rerender(timeline([prompt, changed]));
  expect(
    screen.getByRole('button', { name: 'Still writing below. Jump to latest' }),
  ).toBeTruthy();
  await view.rerender(
    timeline([prompt, { ...changed, status: 'completed' }], false),
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'New reply below. Jump to latest' }),
  );
  expect(end).toHaveBeenLastCalledWith({ animated: false });
  expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  end.mockRestore();
});
it('does not mark prepended history or content resizing as a new reply or pull the reader down', async () => {
  const end = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  const view = await render(timeline());
  await readEarlier();
  end.mockClear();
  await view.rerender(
    timeline([
      { ...answer, id: 'old', ordinal: 0, status: 'completed' },
      prompt,
      answer,
    ]),
  );
  await fireEvent(
    screen.getByLabelText('Conversation'),
    'contentSizeChange',
    400,
    2200,
  );
  expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Still writing/ })).toBeNull();
  expect(end).not.toHaveBeenCalled();
  end.mockRestore();
});
it('detects new text even before a line wraps and clears unread on manual return', async () => {
  const view = await render(timeline());
  await readEarlier();
  await view.rerender(
    timeline([prompt, { ...answer, text: 'First words!', revision: 2 }]),
  );
  expect(screen.getByRole('button', { name: /Still writing/ })).toBeTruthy();
  await scroll(1180);
  expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
});
it('follows a new submitted user prompt while the reader is away', async () => {
  const end = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  const view = await render(timeline());
  await readEarlier();
  end.mockClear();
  await view.rerender(
    timeline([prompt, answer, { ...prompt, id: 'next', ordinal: 3 }]),
  );
  expect(end).toHaveBeenCalledWith({ animated: false });
  expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  end.mockRestore();
});
it('shows the jump control if streaming grows after the reader releases near the bottom', async () => {
  const view = await render(timeline());
  await scroll(1200);
  await fireEvent(screen.getByLabelText('Conversation'), 'scrollBeginDrag');
  await scroll(1170);
  await fireEvent(screen.getByLabelText('Conversation'), 'scrollEndDrag', {
    nativeEvent: { velocity: { x: 0, y: 0 } },
  });
  await view.rerender(
    timeline([prompt, { ...answer, text: 'More output', revision: 2 }]),
  );
  await fireEvent(
    screen.getByLabelText('Conversation'),
    'contentSizeChange',
    400,
    2200,
  );
  expect(screen.getByRole('button', { name: /Still writing/ })).toBeTruthy();
});

it('keeps unread and reader position when native remeasurement briefly reports the bottom', async () => {
  const end = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  try {
    const view = await render(timeline());
    await readEarlier();
    await view.rerender(
      timeline([prompt, { ...answer, text: 'More words', revision: 2 }]),
    );
    await view.rerender(
      timeline(
        [
          prompt,
          { ...answer, text: 'More words', revision: 3, status: 'completed' },
        ],
        false,
      ),
    );
    end.mockClear();
    await fireEvent.scroll(screen.getByLabelText('Conversation'), {
      nativeEvent: {
        contentSize: { height: 1000, width: 400 },
        layoutMeasurement: { height: 600, width: 400 },
        contentOffset: { x: 0, y: 400 },
      },
    });
    await fireEvent(
      screen.getByLabelText('Conversation'),
      'contentSizeChange',
      400,
      1800,
    );
    expect(end).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'New reply below. Jump to latest' }),
    ).toBeTruthy();
  } finally {
    end.mockRestore();
  }
});
