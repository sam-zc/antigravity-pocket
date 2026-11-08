import { describe, it, expect, afterAll } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateAppTrust } from '../services/gateway/src/experimental/app-trust.js';

const dir = mkdtempSync(join(tmpdir(), 'pocket-app-trust-'));
function certificate(name: string, san: string) {
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, `${name}.key`),
      '-out',
      join(dir, `${name}.pem`),
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      `subjectAltName=${san}`,
    ],
    { stdio: 'ignore' },
  );
  return readFileSync(join(dir, `${name}.pem`));
}
const cert = certificate('first', 'DNS:localhost,IP:127.0.0.1');
const rotated = certificate('second', 'DNS:localhost,IP:127.0.0.1');
const wrongHost = certificate('wrong', 'DNS:other.invalid,IP:127.0.0.1');
const fingerprint = (pem: Buffer) =>
  new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe('reviewed connector-local public trust', () => {
  it('accepts the same reviewed certificate across fresh loads', () => {
    expect(validateAppTrust(cert, fingerprint(cert))).toEqual(cert);
    expect(
      validateAppTrust(readFileSync(join(dir, 'first.pem')), fingerprint(cert)),
    ).toEqual(cert);
  });
  it('fails closed on rotation until the new provenance is explicitly reviewed', () => {
    expect(() => validateAppTrust(rotated, fingerprint(cert))).toThrow(
      'certificate_rotation_requires_review',
    );
    expect(validateAppTrust(rotated, fingerprint(rotated))).toEqual(rotated);
  });
  it('checks SAN even when the common name says localhost', () => {
    expect(() => validateAppTrust(wrongHost, fingerprint(wrongHost))).toThrow(
      'certificate_hostname_mismatch',
    );
  });
  it('rejects expiry and future certificates', () => {
    const x509 = new X509Certificate(cert);
    expect(() =>
      validateAppTrust(cert, fingerprint(cert), Date.parse(x509.validTo)),
    ).toThrow('certificate_expired_or_not_yet_valid');
    expect(() =>
      validateAppTrust(cert, fingerprint(cert), Date.parse(x509.validFrom) - 1),
    ).toThrow('certificate_expired_or_not_yet_valid');
  });
  it('rejects private material, missing pins and multiple anchors', () => {
    expect(() =>
      validateAppTrust(readFileSync(join(dir, 'first.key')), fingerprint(cert)),
    ).toThrow('invalid_trust_file');
    expect(() => validateAppTrust(cert, '')).toThrow('invalid_trust_file');
    expect(() =>
      validateAppTrust(Buffer.concat([cert, rotated]), fingerprint(cert)),
    ).toThrow('invalid_trust_file');
  });
});
