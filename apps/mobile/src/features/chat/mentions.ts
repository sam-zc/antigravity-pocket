export type MentionItem = { id: string; label: string; description: string };
export const mockMentions: MentionItem[] = [
  { id: 'mock', label: 'Mock', description: 'The local synthetic agent' },
  {
    id: 'sandbox',
    label: 'Sandbox',
    description: 'Built-in fixtures · no file access',
  },
];
export function mentionAt(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  const start = before.lastIndexOf('@');
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]!))) return null;
  const query = before.slice(start + 1);
  return /\s/.test(query) || query.length > 48
    ? null
    : { start, end: cursor, query };
}
export function rankMentions(items: MentionItem[], query: string) {
  const q = query.toLowerCase();
  if (!q) return items;
  const score = (item: MentionItem) => {
    const label = item.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.split(/[\s\-_./]+/).some((word) => word.startsWith(q))) return 1;
    if (label.includes(q)) return 2;
    return item.description.toLowerCase().includes(q) ? 3 : -1;
  };
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map(({ item }) => item);
}
