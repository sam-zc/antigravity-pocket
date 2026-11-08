import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MessageComposer } from '../src/features/chat/MessageComposer';
import { SessionList } from '../src/features/sessions/SessionList';
import { MessageTimeline } from '../src/features/chat/MessageTimeline';
import { Button, Dialog, Input, Tabs } from '../src/components/ui/primitives';
import { Notice } from '../src/components/ui/Notice';
import { ThemeProvider } from '../src/theme/Theme';
import { WORKSPACE_ID } from '@pocket/protocol';
const id = '00000000-0000-4000-8000-000000000002';
describe('native intent and accessibility contracts', () => {
  it('sends controlled text without clearing it before receipt, and swaps to Stop', async () => {
    const submit = jest.fn();
    const stop = jest.fn();
    const view = await render(
      <MessageComposer
        value="retained draft"
        onValueChange={jest.fn()}
        onSubmit={submit}
        onStop={stop}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(submit).toHaveBeenCalledWith('retained draft');
    expect(screen.getByDisplayValue('retained draft')).toBeTruthy();
    await view.rerender(
      <MessageComposer
        value="retained draft"
        onValueChange={jest.fn()}
        onSubmit={submit}
        onStop={stop}
        status="streaming"
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('blocks empty/offline/busy/oversized sends and retains failed drafts', async () => {
    const submit = jest.fn();
    const props = {
      onValueChange: jest.fn(),
      onSubmit: submit,
      onStop: jest.fn(),
    };
    const view = await render(<MessageComposer {...props} value=" " />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await view.rerender(
      <MessageComposer {...props} value="offline draft" disabled />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await view.rerender(
      <MessageComposer {...props} value="still here" status="submitted" />,
    );
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await view.rerender(
      <MessageComposer {...props} value="still here" status="error" />,
    );
    expect(screen.getByDisplayValue('still here')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry send' }));
    expect(submit).toHaveBeenCalledWith('still here');
    await view.rerender(
      <MessageComposer {...props} value={'🛰'.repeat(20000)} />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
  it('searches real session props, distinguishes empty search, and emits navigation', async () => {
    const select = jest.fn();
    await render(
      <SessionList
        sessions={[
          {
            id,
            title: 'Transport checks',
            workspaceId: WORKSPACE_ID,
            adapterId: 'mock',
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]}
        onSelect={select}
        onMore={jest.fn()}
        hasMore={false}
      />,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Transport checks' }),
    );
    expect(select).toHaveBeenCalledWith(id);
    await fireEvent.changeText(
      screen.getByLabelText('Search sessions'),
      'nothing',
    );
    expect(screen.getByText('No loaded sessions match “nothing”')).toBeTruthy();
  });
  it('uses native modal close, controlled tabs, field validation and busy buttons', async () => {
    const close = jest.fn();
    const change = jest.fn();
    await render(
      <ThemeProvider>
        <Dialog open onClose={close} title="New session">
          <Input label="Title" value="" error="Enter a title" />
          <Tabs
            label="Views"
            value="home"
            items={[
              { value: 'home', label: 'Home' },
              { value: 'sessions', label: 'Sessions' },
            ]}
            onValueChange={change}
          />
          <Button label="Save" status="pending" onPress={jest.fn()} />
        </Dialog>
      </ThemeProvider>,
    );
    expect(screen.getByText('Enter a title')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Home' })).toBeSelected();
    await fireEvent.press(screen.getByRole('tab', { name: 'Sessions' }));
    expect(change).toHaveBeenCalledWith('sessions');
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('shows recovery and detail actions without fabricated activity', async () => {
    const retry = jest.fn();
    await render(
      <Notice
        kind="offline"
        description="Gateway unavailable"
        details="Request example"
        onRetry={retry}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('Request example')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('virtualizes message props and offers latest after the reader scrolls away', async () => {
    await render(
      <MessageTimeline
        messages={[
          {
            id,
            sessionId: id,
            runId: id,
            ordinal: 1,
            role: 'assistant',
            status: 'streaming',
            revision: 1,
            text: 'Actual output',
          },
        ]}
        streaming
        hasOlder={false}
        onOlder={jest.fn()}
      />,
    );
    expect(screen.getByText('Actual output')).toBeTruthy();
    const list = screen.getByLabelText('Conversation');
    await fireEvent(list, 'scrollBeginDrag');
    await fireEvent.scroll(list, {
      nativeEvent: {
        contentSize: { height: 1200, width: 300 },
        layoutMeasurement: { height: 400, width: 300 },
        contentOffset: { x: 0, y: 100 },
      },
    });
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  });
});
