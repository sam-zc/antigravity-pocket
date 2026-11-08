import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { ThemeProvider } from '../src/theme/Theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Input } from '../src/components/ui/Input';
import { Notice } from '../src/components/ui/Notice';
import { MessageComposer } from '../src/features/chat/MessageComposer';
import { StreamingParagraph } from '../src/features/chat/StreamingParagraph';

it('keeps retained closing notice content out of accessibility and supports immediate reopen', async () => {
  await render(<Notice description="Offline" details="Only real details" />);
  expect(screen.queryByText('Only real details')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('Only real details')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Hide details' }));
  expect(screen.queryByText('Only real details')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText('Only real details')).toBeTruthy();
});
it('makes the animated clear control inert and inaccessible when absent or disabled', async () => {
  const change = jest.fn();
  const view = await render(
    <Input label="Search" clearable value="" onChangeText={change} />,
  );
  expect(screen.queryByRole('button', { name: 'Clear Search' })).toBeNull();
  await view.rerender(
    <Input label="Search" clearable value="query" onChangeText={change} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Clear Search' }));
  expect(change).toHaveBeenCalledWith('');
  await view.rerender(
    <Input
      label="Search"
      clearable
      value="query"
      editable={false}
      onChangeText={change}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Clear Search' })).toBeNull();
});
it('exposes only the current composer action during icon transitions and cannot stop twice while pending', async () => {
  const stop = jest.fn();
  const submit = jest.fn();
  const props = {
    value: 'Keep my draft',
    onValueChange: jest.fn(),
    onSubmit: submit,
    onStop: stop,
  };
  const view = await render(<MessageComposer {...props} status="submitted" />);
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  await view.rerender(<MessageComposer {...props} status="streaming" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
  await view.rerender(
    <MessageComposer {...props} status="streaming" stopping />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Stopping…' }));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('Keep my draft')).toBeTruthy();
});
it.each([false, true])(
  'preserves streamed and settled text with reduced motion %s',
  async (reduced) => {
    const preference = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(reduced);
    try {
      const view = await render(
        <StreamingParagraph text="First  word" streaming />,
        { wrapper: ThemeProvider },
      );
      expect(screen.getByText('First  word')).toBeTruthy();
      await view.rerender(
        <StreamingParagraph text={'First  word\nnext line'} streaming />,
      );
      expect(screen.getByText('First  word next line')).toBeTruthy();
      await view.rerender(
        <StreamingParagraph
          text={'First  word\nnext line'}
          streaming={false}
        />,
      );
      expect(screen.getByText('First  word next line')).toBeTruthy();
    } finally {
      preference.mockRestore();
    }
  },
);
