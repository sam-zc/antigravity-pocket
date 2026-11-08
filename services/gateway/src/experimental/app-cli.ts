import { parseArgs } from 'node:util';
import { appOwnerCommand } from './app-owner.js';

export const appHelp = `Experimental local App administration (same-owner IPC only)
  app setup --version 2.29.0 --pid PID --port PORT --ca /absolute/public.pem --pin SHA256
  app enroll --url 'http://127.0.0.1:PORT/c/CONVERSATION?project=PROJECT' --title TITLE [--offset N] [--disposable] [--coding]
  app status
  app disable --conversation UUID
  app enable --conversation UUID
  app send --conversation UUID --on | --off
  app pilot --conversation UUID --on | --off
  app paired-send --conversation UUID --on | --off
Start the gateway with POCKET_EXPERIMENTAL_APP_PROJECTION=1; no enrollment file.
Enrollment and re-enable are read-only. Send is a separate opt-in to App-owned behavior.
An offset is an explicit requested absolute step index, not an inferred count or cursor.
Use only a previously observed offset; no automatic scanning. Earlier history stays omitted.
Coding mode is read-only, with explicit bounded windows, never a complete/recent-history claim.
Paired read-only requires POCKET_APP_ACCESS=paired-read-only with a trusted paired profile.
In paired-read-only, phone sends/resolution/control are always denied.
Paired sending requires POCKET_APP_ACCESS=paired-send, pilot sharing, paired-send opt-in,
and a separately confirmed device pairing with exact session:read + session:write grants.
Existing pairings never expand. Coding sources remain read-only.
Trust must have reviewed certificate provenance. Setup never captures or installs trust.`;

export function parseAppArgs(args: string[]) {
  const action = args[0] ?? 'status';
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      version: { type: 'string' },
      pid: { type: 'string' },
      port: { type: 'string' },
      ca: { type: 'string' },
      pin: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      offset: { type: 'string' },
      disposable: { type: 'boolean' },
      coding: { type: 'boolean' },
      conversation: { type: 'string' },
      on: { type: 'boolean' },
      off: { type: 'boolean' },
    },
  });
  if (positionals.length) throw new Error('Unexpected argument');
  const body: { [key: string]: unknown } = {
    ...values,
    action: `app-${action}`,
  };
  for (const key of ['pid', 'port', 'offset'])
    if (typeof body[key] === 'string') {
      if (!/^\d+$/.test(body[key] as string))
        throw new Error('Expected decimal integer');
      body[key] = Number(body[key]);
    }
  if (action === 'send' || action === 'pilot' || action === 'paired-send') {
    if (!!values.on === !!values.off)
      throw new Error('Choose exactly --on or --off');
    delete body.on;
    delete body.off;
    body.enabled = !!values.on;
  }
  return appOwnerCommand.parse(body);
}
