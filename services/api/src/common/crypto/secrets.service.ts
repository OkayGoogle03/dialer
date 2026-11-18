import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../../config/env';

/**
 * AES-256-GCM for SIP trunk and ARI credentials at rest. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 * Plaintext is only decrypted server-side at the moment a call is originated or a connectivity test runs;
 * no API returns it.
 */
@Injectable()
export class SecretsService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.credentialsKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(stored: string): string {
    const [v, iv, tag, ct] = stored.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unsupported secret format');
    const d = createDecipheriv('aes-256-gcm', this.config.credentialsKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
}
