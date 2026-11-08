import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MessageComposer } from '../src/features/chat/MessageComposer';
import { MessageBubble } from '../src/features/chat/MessageBubble';
import { MessageEdit } from '../src/features/chat/MessageEdit';
import { CodeBlock } from '../src/features/chat/CodeBlock';
import {
  mentionAt,
  mockMentions,
  rankMentions,
} from '../src/features/chat/mentions';
const id = '00000000-0000-4000-8000-000000000002';
it('folds long code and wraps it without offering execution or application', async () => {
  await render(
    <CodeBlock
      language="ts"
      code={Array.from({ length: 24 }, (_, n) => `line ${n}`).join('\n')}
    />,
  );
  expect(screen.queryByText(/line 23/)).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Show 6 more lines' }),
  );
  expect(screen.getByText(/line 23/)).toBeTruthy();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Wrap code lines' }),
  );
  expect(
    screen.getByRole('button', { name: 'Wrap code lines' }),
  ).toBeSelected();
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
});
it('inserts selected visible context into a draft without sending it', async () => {
  const submit = jest.fn();
  function Composer() {
    const [text, setText] = useState('');
    return (
      <MessageComposer
        value={text}
        onValueChange={setText}
        onSubmit={submit}
        onStop={jest.fn()}
      />
    );
  }
  await render(<Composer />);
  await fireEvent.press(screen.getByRole('button', { name: 'Add mention' }));
  await fireEvent.press(
    screen.getByRole('button', { name: 'Mention Sandbox' }),
  );
  expect(screen.getByDisplayValue('@Sandbox ')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  expect(submit).toHaveBeenCalledWith('@Sandbox ');
});
it('does not interpret email addresses or completed tokens as mention triggers', () => {
  expect(mentionAt('person@example.com', 18)).toBeNull();
  expect(mentionAt('@Mock ', 6)).toBeNull();
  expect(mentionAt('Ask @sa', 7)?.query).toBe('sa');
  expect(rankMentions(mockMentions, 'sandbox').map((item) => item.id)).toEqual([
    'sandbox',
  ]);
  expect(rankMentions(mockMentions, 'gmail')).toEqual([]);
});
it('cancels edits and sends changed text without mutating the durable message', async () => {
  const edit = jest.fn().mockResolvedValue(true);
  await render(
    <MessageBubble
      busy={false}
      onEdit={edit}
      message={{
        id,
        sessionId: id,
        runId: id,
        ordinal: 1,
        role: 'user',
        status: 'completed',
        revision: 1,
        text: 'Original prompt',
      }}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Edit message' }));
  expect(
    screen.getByRole('button', { name: 'Send edited message' }),
  ).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Dismiss overlay' })).toBeNull();
  await fireEvent.changeText(
    screen.getByLabelText('Edited message'),
    'Discarded edit',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel edit' }));
  expect(edit).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Edit message' }));
  expect(screen.getByDisplayValue('Original prompt')).toBeTruthy();
  await fireEvent.changeText(
    screen.getByLabelText('Edited message'),
    'A new explicit prompt',
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Send edited message' }),
  );
  expect(edit).toHaveBeenCalledWith('A new explicit prompt');
  expect(screen.getByText('Original prompt')).toBeTruthy();
});
it('filters native mentions, reports no matches, and preserves text after a middle insertion', async () => {
  const submit = jest.fn();
  function Composer() {
    const [text, setText] = useState('Ask @sa tomorrow');
    return (
      <MessageComposer
        value={text}
        onValueChange={setText}
        onSubmit={submit}
        onStop={jest.fn()}
      />
    );
  }
  await render(<Composer />);
  await fireEvent(screen.getByLabelText('Message'), 'selectionChange', {
    nativeEvent: { selection: { start: 7, end: 7 } },
  });
  expect(screen.queryByRole('button', { name: 'Mention Mock' })).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Mention Sandbox' }),
  );
  expect(screen.getByDisplayValue('Ask @Sandbox  tomorrow')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Message'), '@missing');
  await fireEvent(screen.getByLabelText('Message'), 'selectionChange', {
    nativeEvent: { selection: { start: 8, end: 8 } },
  });
  expect(screen.getByText('No matches for “missing”')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Close mentions' }));
  expect(screen.queryByText('No matches for “missing”')).toBeNull();
  expect(screen.getByDisplayValue('@missing')).toBeTruthy();
});
it('releases inline editing when a virtualized message leaves the timeline', async () => {
  const editing = jest.fn();
  const view = await render(
    <MessageBubble
      busy={false}
      onEdit={jest.fn()}
      onEditingChange={editing}
      message={{
        id,
        sessionId: id,
        runId: id,
        ordinal: 1,
        role: 'user',
        status: 'completed',
        revision: 1,
        text: 'Original',
      }}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Edit message' }));
  expect(editing).toHaveBeenLastCalledWith(true);
  await view.unmount();
  expect(editing).toHaveBeenLastCalledWith(false);
});
it('keeps an inline edit after failed delivery and prevents a second send while pending', async () => {
  let finish!: (accepted: boolean) => void;
  const submit = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await render(
    <MessageEdit
      text="Original"
      disabled={false}
      onCancel={jest.fn()}
      onAccept={submit}
    />,
  );
  await fireEvent.changeText(
    screen.getByLabelText('Edited message'),
    'Changed prompt',
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Send edited message' }),
  );
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel edit' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Sending…' }));
  expect(submit).toHaveBeenCalledTimes(1);
  await act(() => finish(false));
  expect(screen.getByDisplayValue('Changed prompt')).toBeTruthy();
  expect(
    screen.getByText('Could not send. Your edit is retained. Try again.'),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Send edited message' }),
  ).not.toBeDisabled();
});

it('folds a measured long prompt, reverses disclosure and preserves its full edit text', async () => {
  const text = 'Long prompt '.repeat(30);
  const pause = jest.fn();
  await render(
    <MessageBubble
      busy={false}
      onEdit={jest.fn()}
      onDisclosure={pause}
      message={{
        id,
        sessionId: id,
        runId: id,
        ordinal: 1,
        role: 'user',
        status: 'completed',
        revision: 1,
        text,
      }}
    />,
  );
  await fireEvent(
    screen.getByTestId('prompt-measurement', { includeHiddenElements: true }),
    'textLayout',
    {
      nativeEvent: { lines: Array.from({ length: 8 }, () => ({ height: 22 })) },
    },
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Expand message' }));
  expect(
    screen.getByRole('button', { name: 'Collapse message' }),
  ).toBeExpanded();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Collapse message' }),
  );
  expect(pause).toHaveBeenCalledTimes(2);
  await fireEvent.press(screen.getByRole('button', { name: 'Edit message' }));
  expect(screen.getByDisplayValue(text)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Expand message' })).toBeNull();
});
