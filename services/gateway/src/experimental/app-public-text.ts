import { ProbeError } from './app-probe.js';
import { string } from './app-wire.js';
const unsafe =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer\s+\S+|AIza[\w-]{20,}|gh[pousr]_[\w]{16,}|sk-[\w-]{16,})|\b(?:password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=]\s*\S+/i;
export function publicText(
  value: number | Buffer | undefined,
  limit = 768,
  maxInput = 262144,
  maxLines = 1000,
) {
  if (value === undefined) return { text: '', omitted: false };
  const text = string(value, maxInput);
  if (unsafe.test(text)) throw new ProbeError('unsafe_content');
  // Linear authority scan avoids nested greedy matching on hostile long URLs.
  for (const match of text.matchAll(/https?:\/\/[^\s/]+/gi))
    if (match[0].includes('@')) throw new ProbeError('unsafe_content');
  for (const point of text) {
    const code = point.codePointAt(0)!;
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
      throw new ProbeError('unsafe_content');
  }
  // Preserve UTF-8 code points and disclose every shortened public field.
  let output = '',
    used = 0,
    lines = 0;
  for (const point of text) {
    const n = Buffer.byteLength(point);
    if (used + n > limit) break;
    if (point === '\n' && ++lines >= maxLines) break;
    output += point;
    used += n;
  }
  return { text: output, omitted: output.length !== text.length };
}
