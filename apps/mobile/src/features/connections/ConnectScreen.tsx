import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import {
  Button,
  Input,
  Screen,
  Text,
  styles,
} from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { PairingScreen } from './PairingScreen';
import { usePocket } from '../../services/PocketProvider';
export function ConnectScreen() {
  const { connect, notice, restoring } = usePocket();
  const [development, setDevelopment] = useState(false);
  const [origin, setOrigin] = useState('http://127.0.0.1:4317');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await connect(origin, token);
      setToken('');
    } catch {
      setError(
        'Could not connect. Check that the gateway is running, the loopback address is correct, and the development credential is current.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.stack}
        keyboardShouldPersistTaps="handled"
      >
        <Text muted>ANTIGRAVITY POCKET · UNOFFICIAL</Text>
        <Text heading>Your agents, within reach.</Text>
        {!!notice && <Notice description={notice} />}
        {restoring ? (
          <Text>Checking saved session…</Text>
        ) : (
          !development && <PairingScreen />
        )}
        <Button
          label={
            development
              ? 'Hide emulator connection'
              : 'Use local emulator development'
          }
          variant="ghost"
          disabled={restoring}
          onPress={() => setDevelopment((v) => !v)}
        />
        {development && (
          <>
            <Notice
              kind="info"
              title="Local experimental companion"
              description="Use the installed Android development app with the local gateway. Mock is the default; App conversations require desktop owner enrollment. This credential never authorizes remote access."
            />
            <Input
              label="Gateway address"
              value={origin}
              onChangeText={setOrigin}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label="Development credential"
              hint="Copy token from the gateway’s owner-only development-access.json. It stays in app memory."
              secureTextEntry
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {error && <Notice description={error} />}
            <Button
              label="Connect to local gateway"
              status={busy ? 'pending' : 'idle'}
              pendingLabel="Connecting…"
              disabled={!token || restoring}
              onPress={() => {
                void submit();
              }}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
