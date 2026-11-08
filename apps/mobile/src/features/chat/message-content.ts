export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; language: string; closed: boolean };
// Plain text plus fenced code only. Never interpret HTML, URLs or commands.
export function messageContent(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const fence = /^```([\w+-]*)[^\S\n]*\n/gm;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (match.index > offset)
      blocks.push({ kind: 'text', text: text.slice(offset, match.index) });
    const end = /^```\s*$/gm;
    end.lastIndex = fence.lastIndex;
    const close = end.exec(text);
    blocks.push({
      kind: 'code',
      language: match[1] ?? '',
      text: text.slice(fence.lastIndex, close?.index ?? text.length),
      closed: !!close,
    });
    offset = close ? end.lastIndex : text.length;
    fence.lastIndex = offset;
    if (!close) break;
  }
  if (offset < text.length)
    blocks.push({ kind: 'text', text: text.slice(offset) });
  return blocks;
}
