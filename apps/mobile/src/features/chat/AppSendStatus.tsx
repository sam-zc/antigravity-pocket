import React, { useState } from 'react';
import { View } from 'react-native';
import type { AppCommand } from '@pocket/protocol';
import { Notice } from '../../components/ui/Notice';
import { Button, Dialog, Text } from '../../components/ui/primitives';

export function AppSendStatus({
  command,
  pending,
  resolving,
  offline = false,
  canResolve = true,
  onCheck,
  onResolve,
}: {
  command: AppCommand | null;
  pending: boolean;
  resolving: boolean;
  offline?: boolean;
  canResolve?: boolean;
  onCheck: () => void;
  onResolve: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (!pending && !command) return null;
  const uncertain = !command || command.delivery === 'uncertain';
  const title = uncertain
    ? 'Delivery uncertain'
    : command.delivery === 'acknowledged'
      ? 'App acknowledged the request'
      : command.delivery === 'not_sent'
        ? 'Not sent to App'
        : command.delivery === 'received'
          ? 'Received by gateway'
          : 'Awaiting App acknowledgement';
  return (
    <View style={{ paddingHorizontal: 16, gap: 8 }}>
      <Notice
        kind={uncertain ? 'error' : 'info'}
        title={title}
        description={
          command?.resolvedAt
            ? 'Resolved locally without resending. The recorded delivery status is unchanged.'
            : uncertain
              ? 'The App may have received this prompt. Review the original conversation before resolving. No automatic resend.'
              : command?.delivery === 'acknowledged'
                ? 'The App acknowledged this request. Its response cannot be linked automatically.'
                : 'The gateway saved your request. Waiting for the App acknowledgement; no automatic retries.'
        }
      />
      {pending && (
        <Button
          label="Check send status"
          variant="ghost"
          disabled={offline}
          onPress={onCheck}
        />
      )}
      {pending && uncertain && canResolve && (
        <Button
          label="Resolve without resending"
          variant="ghost"
          disabled={resolving || offline}
          onPress={() => setConfirm(true)}
        />
      )}
      <Dialog
        open={confirm && canResolve && !offline}
        onClose={() => setConfirm(false)}
        title="Resolve uncertain delivery?"
      >
        <Text>
          Review the original App conversation. This keeps delivery uncertain,
          records your resolution and never sends again. A new prompt may
          duplicate work already accepted.
        </Text>
        <Button
          label="Keep uncertain; do not resend"
          disabled={resolving || offline}
          onPress={() => {
            setConfirm(false);
            onResolve();
          }}
        />
      </Dialog>
    </View>
  );
}
