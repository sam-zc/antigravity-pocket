import React, { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Button,
  Card,
  Screen,
  Tabs,
  Text,
  styles,
} from '../../components/ui/primitives';
import { WorkspaceAccess } from './WorkspaceAccess';
import { Notice } from '../../components/ui/Notice';
import { useTheme } from '../../theme/Theme';
import { usePocket } from '../../services/PocketProvider';
export function SettingsScreen() {
  const router = useRouter();
  const { preference, setPreference } = useTheme();
  const { runtime, disconnect, reauthenticate, notice } = usePocket();
  const [error, setError] = useState('');
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.stack}>
        <Button
          label="Back to chat"
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text heading>Settings</Text>
        <Card>
          <Text>Appearance</Text>
          <Tabs
            label="Appearance"
            value={preference}
            items={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onValueChange={(v) =>
              setPreference(v as 'system' | 'light' | 'dark')
            }
          />
        </Card>
        <Card>
          <Text>
            {runtime?.api.credential
              ? 'Paired connection'
              : 'Development connection'}
          </Text>
          <Text selectable muted>
            {runtime?.api.origin}
          </Text>
          {runtime?.api.credential ? (
            <Text>
              Refresh credentials use native secure storage. Logout revokes this
              device when online and always clears local credentials and cache.
              Offline logout requires desktop revocation.
            </Text>
          ) : (
            <Text>
              Credentials stay in memory and expire after eight hours or gateway
              restart. Updating the credential keeps your drafts. Disconnect
              clears this gateway’s local history and drafts.
            </Text>
          )}
          {!runtime?.api.credential && (
            <Button
              label="Update development credential"
              variant="outline"
              onPress={reauthenticate}
            />
          )}
          <Button
            label="Disconnect and clear local data"
            variant="destructive"
            onPress={() => {
              void disconnect().catch(() =>
                setError(
                  'Connection removed, but local cache cleanup failed. Clear app data before sharing this device.',
                ),
              );
            }}
          />
        </Card>
        <WorkspaceAccess key={runtime?.epoch} />
        {!!notice && <Notice description={notice} />}
        <Button
          label="Open official Antigravity Remote Control"
          variant="outline"
          onPress={() => {
            void Linking.openURL('https://antigravity.google.com/').catch(() =>
              setError('Could not open the browser.'),
            );
          }}
        />
        {error && <Notice description={error} />}
        <Text muted>
          Mock remains the only adapter. Pairing and read-only workspace
          services do not enable Gemini, shell execution, approvals or
          notifications.
        </Text>
      </ScrollView>
    </Screen>
  );
}
