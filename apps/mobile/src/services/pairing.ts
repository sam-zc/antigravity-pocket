import { requireSecureNative } from './native-security';
import {
  claimReceiptSchema,
  claimStatusSchema,
  invitationSchema,
  tokenPairSchema,
  type Invitation,
  type TokenPair,
  type z,
} from '@pocket/protocol';
import { getRandomBytes } from 'expo-crypto';
import { wire } from './wire';
export class Pairing {
  readonly invitation: Invitation;
  private claim?: z.infer<typeof claimReceiptSchema>;
  private exchanged = false;
  constructor(raw: string) {
    requireSecureNative();
    if (raw.length > 2048) throw new Error('Unsupported QR');
    this.invitation = invitationSchema.parse(JSON.parse(raw));
    if (
      this.invitation.expiresAt <= Date.now() ||
      this.invitation.expiresAt > Date.now() + 125000
    )
      throw new Error('Invitation expired or clock differs');
  }
  async start(name: string) {
    if (this.claim) throw new Error('Already claimed');
    const nonce = Array.from(getRandomBytes(32), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    this.claim = await wire(
      this.invitation.origin,
      '/v1/pairing/claims',
      claimReceiptSchema,
      {
        invitationId: this.invitation.invitationId,
        secret: this.invitation.secret,
        name,
        nonce,
      },
    );
    return { code: this.claim.code, claimId: this.claim.claimId };
  }
  async status() {
    if (!this.claim) throw new Error('Claim required');
    if (Date.now() >= this.invitation.expiresAt)
      return { state: 'expired' as const, deviceId: null, grants: [] };
    return wire(
      this.invitation.origin,
      `/v1/pairing/claims/${this.claim.claimId}/status`,
      claimStatusSchema,
      { receipt: this.claim.receipt },
    );
  }
  async exchange(): Promise<TokenPair> {
    if (!this.claim || this.exchanged)
      throw new Error(
        'Exchange cannot be retried. Revoke the orphan device on desktop and pair again.',
      );
    this.exchanged = true;
    return wire(
      this.invitation.origin,
      `/v1/pairing/claims/${this.claim.claimId}/exchange`,
      tokenPairSchema,
      { receipt: this.claim.receipt },
    );
  }
}
