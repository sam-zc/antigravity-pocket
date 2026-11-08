import { expect, it } from 'vitest';
import { messageContent } from '../apps/mobile/src/features/chat/message-content';
it('renders complete and streaming fences as inert code, preserving surrounding text', () => {
  expect(messageContent('Before\n```ts\nconst x = 1;\n```\nAfter')).toEqual([
    { kind: 'text', text: 'Before\n' },
    { kind: 'code', language: 'ts', text: 'const x = 1;\n', closed: true },
    { kind: 'text', text: '\nAfter' },
  ]);
  expect(messageContent('```sh\nrm -rf example')).toEqual([
    { kind: 'code', language: 'sh', text: 'rm -rf example', closed: false },
  ]);
  expect(messageContent('<script>example()</script>')).toEqual([
    { kind: 'text', text: '<script>example()</script>' },
  ]);
});
