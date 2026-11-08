import React from 'react';
import { View } from 'react-native';
import type { Message } from '@pocket/protocol';
import { AppCommandDetails } from './AppCommandDetails';
import { Card, Text } from '../../components/ui/primitives';
/** Renders fixed public activity fields; no arbitrary upstream payload rendering. */
export function AppActivityCard({
  message,
  onDisclosure,
}: {
  message: Message;
  onDisclosure?: () => void;
}) {
  const activity = message.activity;
  if (!activity) return null;
  return (
    <Card>
      <View style={{ gap: 4 }}>
        <Text>{activity.label}</Text>
        <Text muted>App observed · {activity.state}</Text>
        <Text muted>
          {activity.detailOmission
            ? 'Details omitted by the window budget.'
            : activity.detail
              ? 'Selected public details available.'
              : activity.kind === 'unknown'
                ? 'Unsupported activity type. Details are not displayed.'
                : activity.kind === 'omitted'
                  ? 'Recognized App activity. Public details are not available in this view.'
                  : 'Details omitted. Step status does not establish execution success.'}
        </Text>
        {activity.detail && (
          <AppCommandDetails
            key={`${message.sessionId}:${message.id}`}
            detail={activity.detail}
            ordinal={message.ordinal}
            onDisclosure={onDisclosure}
          />
        )}
      </View>
    </Card>
  );
}
