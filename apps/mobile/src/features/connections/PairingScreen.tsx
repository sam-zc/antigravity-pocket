import type { Grant } from '@pocket/protocol';
import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Input, Text } from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { secureNativeAvailable } from '../../services/native-security';
import { Pairing } from '../../services/pairing';
import { usePocket } from '../../services/PocketProvider';
export function PairingScreen() {
  const pocket = usePocket();
  const [approved, setApproved] = useState(false),
    [grants, setGrants] = useState<Grant[]>([]);
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false),
    [raw, setRaw] = useState(''),
    [name, setName] = useState('My phone');
  const [pairing, setPairing] = useState<Pairing | null>(null),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const gate = useRef(false),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  function scan(data: string) {
    setCamera(false);
    setRaw('');
    setCode('');
    setApproved(false);
    setGrants([]);
    setError('');
    try {
      setPairing(new Pairing(data));
    } catch {
      setPairing(null);
      setError(
        'Unsupported or expired QR. Ask the desktop owner for a new two-minute invitation.',
      );
    }
  }
  async function claim() {
    if (!pairing || gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const claim = await pairing.start(name);
      if (alive.current) setCode(claim.code);
    } catch {
      setPairing(null);
      setError(
        'Could not claim securely. Check the private network, phone clock and trusted certificate/hostname. No TLS bypass is available. If the claim response was lost, ask for a new invitation.',
      );
    } finally {
      gate.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function finish() {
    if (!pairing || gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const status = await pairing.status();
      if (status.state === 'claimed') {
        setError(
          'Waiting for the desktop owner to compare this code and confirm the exact device and grants.',
        );
        return;
      }
      if (status.state !== 'approved') throw new Error('Unavailable');
      if (!approved) {
        setGrants(status.grants);
        setApproved(true);
        return;
      }
      const pair = await pairing.exchange();
      await pocket.paired(
        pairing.invitation.origin,
        pairing.invitation.gatewayId,
        pair,
      );
    } catch {
      setPairing(null);
      setCode('');
      setError(
        'Pairing expired, was rejected, or its final response was lost. Ask the owner to inspect the claim, revoke any orphan device, and create a new invitation. Do not retry the consumed exchange.',
      );
    } finally {
      gate.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!secureNativeAvailable())
    return (
      <Notice
        kind="info"
        title="UI preview only"
        description="Pairing needs the Phase 2 native build (build 2). Expo Go and older builds do not include the required transport policy. Install the development build to pair securely."
      />
    );
  return (
    <View style={styles.stack}>
      <Text heading>Pair with your desktop</Text>
      <Notice
        kind="info"
        title="Trusted HTTPS required"
        description="Use an owner-provisioned trusted LAN certificate or private Tailscale Serve. Fully offline LAN without installed certificate trust is unsupported. Never share the invitation QR."
      />
      {camera && permission?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => scan(data)}
        />
      ) : null}
      {!pairing ? (
        <>
          <Button
            label="Scan invitation QR"
            onPress={() => {
              void (async () => {
                const p = permission?.granted
                  ? permission
                  : await requestPermission();
                if (p.granted) setCamera(true);
                else
                  setError(
                    'Camera permission denied. Enable it in device settings, or enter the invitation privately.',
                  );
              })().catch(() =>
                setError('Camera unavailable. Enter the invitation privately.'),
              );
            }}
          />
          <Input
            label="Private invitation fallback"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2048}
            value={raw}
            onChangeText={setRaw}
            hint="Only the exact invitation JSON. This field is hidden and never saved."
          />
          <Button
            label="Review invitation"
            disabled={!raw}
            onPress={() => scan(raw)}
          />
        </>
      ) : (
        <>
          <Text selectable>{pairing.invitation.origin}</Text>
          <Text muted>
            Only continue if this hostname belongs to your desktop.
          </Text>
          {!code ? (
            <>
              <Input
                label="Device name"
                value={name}
                onChangeText={setName}
                maxLength={60}
              />
              <Button
                label="Trust this hostname and claim"
                status={busy ? 'pending' : 'idle'}
                onPress={() => {
                  void claim();
                }}
              />
            </>
          ) : (
            <>
              <Text heading>Compare code: {code}</Text>
              <Text>
                The owner must confirm this exact name, code and workspace
                grants on the desktop.
              </Text>
              {approved && (
                <>
                  <Text>Desktop-authorized grants</Text>
                  {grants.map((g) => (
                    <Text key={g.workspaceId}>
                      {g.workspaceId}: {g.scopes.join(', ')}
                    </Text>
                  ))}
                  {!grants.length && <Text>No workspace grants</Text>}
                </>
              )}
              <Button
                label={
                  approved ? 'Complete pairing' : 'Check desktop confirmation'
                }
                status={busy ? 'pending' : 'idle'}
                onPress={() => {
                  void finish();
                }}
              />
            </>
          )}
          <Button
            label="Discard invitation"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              setPairing(null);
              setCode('');
            }}
          />
        </>
      )}
      {!!error && <Notice description={error} />}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 16 },
  camera: { height: 260, width: '100%' },
});
