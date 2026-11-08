import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Input, Text } from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { usePocket } from '../../services/PocketProvider';
export function WorkspaceAccess() {
  const { runtime } = usePocket();
  const [selected, setSelected] = useState(''),
    [path, setPath] = useState(''),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['workspaces', runtime?.gatewayId],
    enabled: !!runtime?.api.credential,
    queryFn: () => runtime!.api.workspaces(),
  });
  async function inspect(operation: 'files' | 'read' | 'status' | 'diff') {
    if (!runtime || !selected || busy) return;
    setBusy(true);
    setError('');
    setText('');
    try {
      if (operation === 'files') {
        const page = await runtime.api.files(selected, path);
        setText(
          page.entries
            .map((e) => e.path + (e.kind === 'directory' ? '/' : ''))
            .join('\n') || 'No visible files',
        );
      } else if (operation === 'read')
        setText((await runtime.api.readFile(selected, path)).text);
      else
        setText(
          (await runtime.api.git(selected, operation, path || undefined))
            .text || 'No changes',
        );
    } catch {
      setError(
        'Unavailable, excluded, offline or permission removed. File reads and Git output are bounded; repository filters and partial clones are refused.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!runtime?.api.credential) return null;
  return (
    <Card>
      <Text>Owner-registered workspaces</Text>
      <Text muted>Read-only. No shell, writes or provider access.</Text>
      {query.isError && (
        <Notice description="Could not load current workspace grants." />
      )}
      {query.data?.items.map((w) => (
        <Button
          key={w.id}
          label={w.name}
          variant="outline"
          onPress={() => {
            setSelected(w.id);
            setPath('');
            setText('');
          }}
        />
      ))}
      {!query.isPending && !query.data?.items.length && (
        <Text>
          No file grants. The desktop owner must register and grant a workspace.
        </Text>
      )}
      {!!selected && (
        <View style={{ gap: 12 }}>
          <Input
            label="Relative file or directory"
            value={path}
            onChangeText={setPath}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            label="List directory"
            disabled={busy}
            onPress={() => {
              void inspect('files');
            }}
          />
          <Button
            label="Read file"
            disabled={busy || !path}
            onPress={() => {
              void inspect('read');
            }}
          />
          <Button
            label="Git status"
            disabled={busy}
            onPress={() => {
              void inspect('status');
            }}
          />
          <Button
            label="File diff"
            disabled={busy || !path}
            onPress={() => {
              void inspect('diff');
            }}
          />
        </View>
      )}
      {!!error && <Notice description={error} />}
      {!!text && <Text selectable>{text}</Text>}
    </Card>
  );
}
