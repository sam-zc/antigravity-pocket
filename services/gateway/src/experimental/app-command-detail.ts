import {
  appActivityDetailSchema,
  type AppActivityDetail,
} from '@pocket/protocol';
import { bytes, integer, selectedFields, single } from './app-wire.js';
import { publicText } from './app-public-text.js';

/** App 2.29.0 fields observed in the selected conversation. No proposed command, debug output or tool metadata. */
export function commandDetail(raw: Buffer): AppActivityDetail {
  const command = selectedFields(raw, [6, 21, 23], [6]);
  const line = single(command, 23);
  const text = line === undefined ? undefined : publicText(line, 256, 4096, 4);
  const combined = single(command, 21);
  const fields =
    combined === undefined ? undefined : selectedFields(bytes(combined), [1]);
  const full = fields && single(fields, 1);
  const output =
    full === undefined ? undefined : publicText(full, 1024, 65536, 48);
  const exit = single(command, 6);
  return appActivityDetailSchema.parse({
    kind: 'command',
    source: 'app-2.29.0/runCommand',
    command: text?.text,
    output: output?.text,
    // Presence matters: absent zero is never inferred from DONE or an empty response.
    exitCode: exit === undefined ? undefined : integer(exit),
    clipped: !!text?.omitted || !!output?.omitted,
  });
}
