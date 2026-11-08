import { randomBytes, randomUUID } from 'node:crypto';
import {
  claimSchema,
  grantsSchema,
  invitationSchema,
  deviceEventSchema,
  type Grant,
  type Scope,
} from '@pocket/protocol';
import { Store, hash } from '../db/store.js';
import { DomainError } from '../errors.js';

const secret = () => randomBytes(32).toString('hex');
const deny = (code = 'session_expired') =>
  new DomainError(
    401,
    code,
    code === 'device_revoked'
      ? 'This device was revoked. Pair again with the desktop owner.'
      : 'Session expired. Pair again with the desktop owner.',
  );
type InvitationRow = {
  id: string;
  state: string;
  expires: number;
  claim: string;
  receipt: string;
  name: string;
  code: string;
  grants: string;
  device: string | null;
};
type Credential = {
  hash: string;
  device: string;
  family: string;
  kind: string;
  expires: number;
  consumed: number;
};
export type Principal = {
  device: string;
  access: string;
  expires: number;
  revision: number;
};
export class Devices {
  // Runtime source visibility supplements durable device grants. It never grants authority.
  visibleWorkspace: (workspace: string) => boolean = () => true;
  onInvalidate: (device: string, code: number) => void = () => {};
  constructor(
    readonly store: Store,
    private now = Date.now,
  ) {}
  private audit(action: string, object: string) {
    this.store.db
      .prepare('INSERT INTO security_audit VALUES(?,?,?,?)')
      .run(randomUUID(), action, object, this.now());
  }
  private expire() {
    this.store.db
      .prepare(
        "UPDATE invitations SET state='expired' WHERE expires<=? AND state IN ('pending','claimed','approved')",
      )
      .run(this.now());
    this.store.db
      .prepare('DELETE FROM tickets WHERE expires<=?')
      .run(this.now());
    this.store.db
      .prepare('DELETE FROM invitations WHERE expires<?')
      .run(this.now() - 86400000);
    this.store.db
      .prepare(
        'DELETE FROM credentials WHERE family IN (SELECT id FROM families WHERE expires<?)',
      )
      .run(this.now() - 7 * 86400000);
    this.store.db
      .prepare('DELETE FROM families WHERE expires<?')
      .run(this.now() - 7 * 86400000);
    this.store.db
      .prepare('DELETE FROM security_audit WHERE at<?')
      .run(this.now() - 90 * 86400000);
  }
  invite(origin: string, grants: Grant[]) {
    grantsSchema.parse(grants);
    return this.store.db.transaction(() => {
      this.expire();
      if (
        (
          this.store.db
            .prepare(
              "SELECT count(*) n FROM invitations WHERE state IN ('pending','claimed','approved')",
            )
            .get() as { n: number }
        ).n >= 8
      )
        throw new DomainError(429, 'capacity', 'Too many pending invitations');
      for (const g of grants)
        if (
          !this.store.db
            .prepare('SELECT 1 FROM workspaces WHERE id=?')
            .get(g.workspaceId)
        )
          throw new DomainError(400, 'workspace', 'Unknown workspace');
      const value = invitationSchema.parse({
        protocolVersion: 1,
        gatewayId: this.store.gatewayId,
        origin,
        invitationId: randomUUID(),
        secret: secret(),
        expiresAt: this.now() + 120000,
      });
      this.store.db
        .prepare(
          "INSERT INTO invitations(id,secret,state,expires,grants) VALUES(?,?,'pending',?,?)",
        )
        .run(
          value.invitationId,
          hash(value.secret),
          value.expiresAt,
          JSON.stringify(grants),
        );
      this.audit('invitation.created', value.invitationId);
      return value;
    })();
  }
  claim(input: unknown) {
    const body = claimSchema.parse(input);
    return this.store.db.transaction(() => {
      const claimId = randomUUID(),
        receipt = secret();
      const code = (
        parseInt(hash(secret() + body.nonce).slice(0, 12), 16) % 1000000
      )
        .toString()
        .padStart(6, '0');
      const result = this.store.db
        .prepare(
          "UPDATE invitations SET state='claimed',claim=?,receipt=?,name=?,code=? WHERE id=? AND secret=? AND state='pending' AND expires>?",
        )
        .run(
          claimId,
          hash(receipt),
          body.name,
          code,
          body.invitationId,
          hash(body.secret),
          this.now(),
        );
      if (!result.changes)
        throw new DomainError(
          409,
          'invitation_unavailable',
          'Invitation used, expired or invalid. Ask for a new invitation.',
        );
      const row = this.store.db
        .prepare('SELECT expires FROM invitations WHERE claim=?')
        .get(claimId) as { expires: number };
      this.audit('invitation.claimed', claimId);
      return { claimId, receipt, code, expiresAt: row.expires };
    })();
  }
  private claimRow(id: string, receipt: string) {
    const row = this.store.db
      .prepare('SELECT * FROM invitations WHERE claim=? AND receipt=?')
      .get(id, hash(receipt)) as InvitationRow | undefined;
    if (!row) throw deny('claim_invalid');
    return row;
  }
  status(id: string, receipt: string) {
    const row = this.claimRow(id, receipt);
    if (row.expires <= this.now()) throw deny('claim_expired');
    return {
      state:
        row.expires <= this.now() &&
        !['consumed', 'rejected'].includes(row.state)
          ? 'expired'
          : row.state,
      deviceId: row.device,
      grants: JSON.parse(row.grants) as Grant[],
    };
  }
  pending() {
    this.expire();
    return this.store.db
      .prepare(
        "SELECT id,claim,name,code,grants,state,expires,device FROM invitations WHERE state IN ('claimed','approved','consumed') ORDER BY expires DESC LIMIT 32",
      )
      .all();
  }
  confirm(
    claim: string,
    name: string,
    code: string,
    grants: Grant[],
    approve: boolean,
  ) {
    grantsSchema.parse(grants);
    this.store.db.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT * FROM invitations WHERE claim=? AND state='claimed' AND expires>?",
        )
        .get(claim, this.now()) as InvitationRow | undefined;
      if (
        !row ||
        row.name !== name ||
        row.code !== code ||
        JSON.stringify(grants) !== row.grants
      )
        throw new DomainError(
          409,
          'confirmation_mismatch',
          'Confirm the exact claim, device name, comparison code and grants',
        );
      this.store.db
        .prepare(
          "UPDATE invitations SET state=? WHERE id=? AND state='claimed'",
        )
        .run(approve ? 'approved' : 'rejected', row.id);
      this.audit(approve ? 'claim.approved' : 'claim.rejected', claim);
    })();
  }
  exchange(id: string, receipt: string) {
    return this.store.db.transaction(() => {
      const row = this.claimRow(id, receipt);
      if (row.state !== 'approved' || row.expires <= this.now())
        throw new DomainError(
          409,
          'exchange_unavailable',
          'Exchange unavailable. If the response was lost, revoke the orphan device on desktop and pair again.',
        );
      if (
        (
          this.store.db.prepare('SELECT count(*) n FROM devices').get() as {
            n: number;
          }
        ).n >= 1000
      )
        throw new DomainError(
          429,
          'device_capacity',
          'Device capacity reached',
        );
      const device = randomUUID(),
        family = randomUUID();
      this.store.db
        .prepare("INSERT INTO devices VALUES(?,?,'active',1,?)")
        .run(device, row.name, this.now());
      this.writeGrants(device, JSON.parse(row.grants) as Grant[]);
      this.store.db
        .prepare('INSERT INTO families VALUES(?,?,?,0)')
        .run(family, device, this.now() + 30 * 86400000);
      this.store.db
        .prepare(
          "UPDATE invitations SET state='consumed',device=? WHERE id=? AND state='approved'",
        )
        .run(device, row.id);
      this.event(device);
      this.audit('device.paired', device);
      return this.mint(device, family);
    })();
  }
  private mint(device: string, family: string) {
    if (
      (
        this.store.db
          .prepare('SELECT count(*) n FROM credentials WHERE family=?')
          .get(family) as { n: number }
      ).n >= 20000 ||
      (
        this.store.db.prepare('SELECT count(*) n FROM credentials').get() as {
          n: number;
        }
      ).n >= 200000
    )
      throw new DomainError(
        429,
        'credential_capacity',
        'Credential budget exhausted; revoke old devices and pair again',
      );
    const row = this.store.db
      .prepare('SELECT expires FROM families WHERE id=?')
      .get(family) as { expires: number };
    const accessToken = secret(),
      refreshToken = secret();
    const accessExpiresAt = Math.min(this.now() + 300000, row.expires),
      refreshExpiresAt = Math.min(this.now() + 7 * 86400000, row.expires);
    for (const [token, kind, expires] of [
      [accessToken, 'access', accessExpiresAt],
      [refreshToken, 'refresh', refreshExpiresAt],
    ] as const)
      this.store.db
        .prepare('INSERT INTO credentials VALUES(?,?,?,?,?,0)')
        .run(hash(token), device, family, kind, expires);
    return {
      deviceId: device,
      accessToken,
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      grantRevision: this.device(device).revision,
    };
  }
  private device(id: string) {
    const row = this.store.db
      .prepare('SELECT status,revision FROM devices WHERE id=?')
      .get(id) as { status: string; revision: number } | undefined;
    if (!row || row.status !== 'active') throw deny('device_revoked');
    return row;
  }
  authenticate(token: string): Principal {
    const row = this.store.db
      .prepare("SELECT * FROM credentials WHERE hash=? AND kind='access'")
      .get(hash(token)) as Credential | undefined;
    if (!row) throw deny();
    const device = this.device(row.device);
    const family = this.store.db
      .prepare('SELECT revoked,expires FROM families WHERE id=?')
      .get(row.family) as { revoked: number; expires: number };
    if (
      row.expires <= this.now() ||
      family.revoked ||
      family.expires <= this.now()
    )
      throw deny();
    return {
      device: row.device,
      access: row.hash,
      expires: row.expires,
      revision: device.revision,
    };
  }
  current(p: Principal) {
    const device = this.device(p.device);
    const row = this.store.db
      .prepare(
        'SELECT c.expires,f.revoked FROM credentials c JOIN families f ON f.id=c.family WHERE c.hash=?',
      )
      .get(p.access) as { expires: number; revoked: number } | undefined;
    if (!row || row.expires <= this.now() || row.revoked) throw deny();
    if (device.revision !== p.revision)
      throw new DomainError(
        403,
        'scope_changed',
        'Permissions changed. Refresh bootstrap and clear cached data.',
      );
  }
  refresh(token: string) {
    // Return the denial out of the transaction so reuse revocation COMMITs.
    this.expire();
    const result = this.store.db.transaction(() => {
      const row = this.store.db
        .prepare("SELECT * FROM credentials WHERE hash=? AND kind='refresh'")
        .get(hash(token)) as Credential | undefined;
      if (!row) return { error: deny() };
      this.device(row.device);
      if (row.consumed) {
        this.store.db
          .prepare('UPDATE families SET revoked=1 WHERE id=?')
          .run(row.family);
        this.audit('refresh.reuse', row.device);
        return { error: deny('refresh_reused'), invalidated: row.device };
      }
      const family = this.store.db
        .prepare('SELECT expires,revoked FROM families WHERE id=?')
        .get(row.family) as { expires: number; revoked: number };
      if (
        family.revoked ||
        family.expires <= this.now() ||
        row.expires <= this.now()
      )
        return { error: deny() };
      this.store.db
        .prepare(
          'UPDATE credentials SET consumed=1 WHERE hash=? AND consumed=0',
        )
        .run(row.hash);
      return { pair: this.mint(row.device, row.family) };
    })();
    if (result.invalidated) this.onInvalidate(result.invalidated, 4001);
    if (result.error) throw result.error;
    return result.pair!;
  }
  ticket(p: Principal) {
    this.current(p);
    this.expire();
    if (
      (
        this.store.db.prepare('SELECT count(*) n FROM tickets').get() as {
          n: number;
        }
      ).n >= 256
    )
      throw new DomainError(
        429,
        'capacity',
        'Connection ticket capacity reached',
      );
    const ticket = secret(),
      expiresAt = Math.min(p.expires, this.now() + 30000);
    this.store.db
      .prepare('INSERT INTO tickets VALUES(?,?,?)')
      .run(hash(ticket), p.access, expiresAt);
    return { ticket, expiresAt };
  }
  consume(token: string): Principal {
    return this.store.db.transaction(() => {
      const row = this.store.db
        .prepare('DELETE FROM tickets WHERE hash=? RETURNING access,expires')
        .get(hash(token)) as { access: string; expires: number } | undefined;
      if (!row || row.expires <= this.now()) throw deny('ticket_invalid');
      const credential = this.store.db
        .prepare('SELECT * FROM credentials WHERE hash=?')
        .get(row.access) as Credential;
      const p = {
        device: credential.device,
        access: row.access,
        expires: credential.expires,
        revision: this.device(credential.device).revision,
      };
      this.current(p);
      return p;
    })();
  }
  allowed(p: Principal, workspace: string, scope: Scope) {
    this.current(p);
    return !!this.store.db
      .prepare(
        'SELECT 1 FROM grants WHERE device=? AND workspace=? AND scope=?',
      )
      .get(p.device, workspace, scope);
  }
  require(p: Principal, workspace: string, scope: Scope) {
    if (!this.allowed(p, workspace, scope))
      throw new DomainError(404, 'not_found', 'Resource unavailable');
  }
  grants(device: string): Grant[] {
    const rows = this.store.db
      .prepare(
        'SELECT workspace,scope FROM grants WHERE device=? ORDER BY workspace,scope',
      )
      .all(device) as { workspace: string; scope: Scope }[];
    const map = new Map<string, Scope[]>();
    for (const r of rows)
      map.set(r.workspace, [...(map.get(r.workspace) ?? []), r.scope]);
    return [...map].map(([workspaceId, scopes]) => ({ workspaceId, scopes }));
  }
  private writeGrants(device: string, grants: Grant[]) {
    this.store.db.prepare('DELETE FROM grants WHERE device=?').run(device);
    for (const grant of grants)
      for (const scope of new Set(grant.scopes))
        this.store.db
          .prepare('INSERT INTO grants VALUES(?,?,?)')
          .run(device, grant.workspaceId, scope);
  }
  reduce(device: string, grants: Grant[]) {
    grantsSchema.parse(grants);
    this.store.db.transaction(() => {
      this.device(device);
      for (const g of grants)
        for (const s of g.scopes)
          if (
            !this.store.db
              .prepare(
                'SELECT 1 FROM grants WHERE device=? AND workspace=? AND scope=?',
              )
              .get(device, g.workspaceId, s)
          )
            throw new DomainError(
              400,
              'grant_expansion',
              'Pair again for expanded grants',
            );
      this.writeGrants(device, grants);
      this.store.db
        .prepare('UPDATE devices SET revision=revision+1 WHERE id=?')
        .run(device);
      this.store.db
        .prepare('DELETE FROM device_events WHERE device=?')
        .run(device);
      this.event(device);
      this.audit('grants.reduced', device);
    })();
    this.onInvalidate(device, 4003);
  }
  revoke(device: string) {
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE devices SET status='revoked',revision=revision+1 WHERE id=? AND status='active'",
        )
        .run(device);
      this.store.db
        .prepare('UPDATE families SET revoked=1 WHERE device=?')
        .run(device);
      this.store.db
        .prepare(
          'DELETE FROM tickets WHERE access IN (SELECT hash FROM credentials WHERE device=?)',
        )
        .run(device);
      this.audit('device.revoked', device);
    })();
    this.onInvalidate(device, 4004);
  }
  list() {
    return this.store.db
      .prepare(
        'SELECT id,name,status,revision,created FROM devices ORDER BY created DESC LIMIT 100',
      )
      .all();
  }
  private event(device: string) {
    const epoch = this.device(device).revision;
    const event = deviceEventSchema.parse({
      protocolVersion: 1,
      eventId: randomUUID(),
      streamId: `device:${device}:${epoch}`,
      sequence: 1,
      timestamp: new Date(this.now()).toISOString(),
      type: 'device.changed',
      payload: { deviceId: device, grantRevision: epoch },
    });
    this.store.db
      .prepare('INSERT INTO device_events VALUES(?,?,1,?)')
      .run(device, epoch, JSON.stringify(event));
  }
  watermark(p: Principal) {
    this.current(p);
    return (
      this.store.db
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) high FROM device_events WHERE device=? AND epoch=?',
        )
        .get(p.device, p.revision) as { high: number }
    ).high;
  }
  snapshot(p: Principal) {
    return this.store.db.transaction(() => {
      this.current(p);
      const grants = this.grants(p.device);
      const page = this.store.list(
        '',
        100,
        grants
          .filter(
            (g) =>
              g.scopes.includes('session:read') &&
              this.visibleWorkspace(g.workspaceId),
          )
          .map((g) => g.workspaceId),
      );
      return {
        deviceId: p.device,
        grantRevision: p.revision,
        streamId: `device:${p.device}:${p.revision}`,
        through: this.watermark(p),
        grants,
        sessions: page.items.map(({ id, workspaceId, title, revision }) => ({
          id,
          workspaceId,
          title,
          revision,
        })),
        nextCursor: page.nextCursor,
      };
    })();
  }
  deviceEvents(p: Principal, stream: string, after: number) {
    this.current(p);
    if (stream !== `device:${p.device}:${p.revision}`)
      throw new DomainError(
        409,
        'epoch_changed',
        'Load a fresh device snapshot',
      );
    const minimum = (
      this.store.db
        .prepare(
          'SELECT MIN(sequence) minimum FROM device_events WHERE device=? AND epoch=?',
        )
        .get(p.device, p.revision) as { minimum: number }
    ).minimum;
    if (after < minimum - 1)
      throw new DomainError(410, 'pruned', 'Load a fresh device snapshot');
    if (after > this.watermark(p))
      throw new DomainError(
        409,
        'future_cursor',
        'Load a fresh device snapshot',
      );
    return (
      this.store.db
        .prepare(
          'SELECT data FROM device_events WHERE device=? AND epoch=? AND sequence>? ORDER BY sequence LIMIT 200',
        )
        .all(p.device, p.revision, after) as { data: string }[]
    ).map((r) => deviceEventSchema.parse(JSON.parse(r.data)));
  }
}
