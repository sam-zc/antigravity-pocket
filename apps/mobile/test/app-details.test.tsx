import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppActivityCard } from '../src/features/chat/AppActivityCard';
import type { Message } from '@pocket/protocol';
const row: Message = {
  id: 'one',
  sessionId: 'a',
  runId: 'run',
  ordinal: 3,
  role: 'activity',
  text: '',
  status: 'completed',
  revision: 1,
  appStepType: 21,
  activity: {
    schemaVersion: 'app-2.29.0',
    kind: 'tool',
    label: 'Run command',
    upstreamType: 21,
    state: 'done',
    detailsOmitted: true,
    detail: {
      kind: 'command',
      source: 'app-2.29.0/runCommand',
      command: 'echo fixture',
      output: '<img src="https://example.com/x"> ../../path',
      exitCode: 0,
      clipped: false,
    },
  },
};
it('renders inert observed output only after disclosure, pauses follow, preserves updates and never exposes execution actions', async () => {
  const pause = jest.fn();
  const view = await render(
    <AppActivityCard message={row} onDisclosure={pause} />,
  );
  expect(screen.queryByText(/<img/)).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Show command details for step 3' }),
  );
  expect(pause).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/<img/)).toBeTruthy();
  expect(screen.getByText('App recorded exit code 0')).toBeTruthy();
  for (const name of ['Apply', 'Run', 'Retry', 'Approve', 'Stop'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  await view.rerender(
    <AppActivityCard
      message={{
        ...row,
        revision: 2,
        activity: {
          ...row.activity!,
          detail: {
            ...row.activity!.detail!,
            output: 'New observed output',
            clipped: true,
            exitCode: undefined,
          },
        },
      }}
    />,
  );
  expect(screen.getByText('New observed output')).toBeTruthy();
  expect(screen.getByText('Exit result not observed')).toBeTruthy();
  expect(screen.getByText(/Content clipped/)).toBeTruthy();
  await view.rerender(
    <AppActivityCard message={{ ...row, id: 'two', sessionId: 'b' }} />,
  );
  expect(screen.queryByText(/<img/)).toBeNull();
  expect(screen.queryByText('New observed output')).toBeNull();
  await view.rerender(<></>);
  expect(screen.queryByText('Command text')).toBeNull();
});
it('shows aggregate omission explicitly without an empty disclosure affordance', async () => {
  await render(
    <AppActivityCard
      message={{
        ...row,
        activity: {
          ...row.activity!,
          detail: undefined,
          detailOmission: 'window_budget',
        },
      }}
    />,
  );
  expect(
    screen.getByText('Details omitted by the window budget.'),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /Show command details/ }),
  ).toBeNull();
});
