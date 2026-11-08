import { X509Certificate } from 'node:crypto';
import { ProbeError } from './app-probe.js';

/** A reviewed public leaf, not a system trust change or peer-capture enrollment. */
export function validateAppTrust(
  pem: Buffer,
  fingerprint: string,
  now = Date.now(),
): Buffer {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      pem.length > 65536 ||
      pem.includes('PRIVATE KEY') ||
      (pem.toString().match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    )
      throw new Error('invalid');
    const cert = new X509Certificate(pem);
    if (cert.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint)
      throw new ProbeError('certificate_rotation_requires_review');
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)
      throw new ProbeError('certificate_expired_or_not_yet_valid');
    if (
      !cert.subjectAltName ||
      !cert.checkHost('localhost', { subject: 'never' }) ||
      !cert.checkIP('127.0.0.1')
    )
      throw new ProbeError('certificate_hostname_mismatch');
    if (!cert.checkIssued(cert) || !cert.verify(cert.publicKey))
      throw new ProbeError('certificate_not_self_signed');
    return pem;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('invalid_trust_file');
  }
}
