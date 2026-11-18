// Prints fresh values for the two secrets that can be generated. Paste them into the host environment (Vercel -> Settings ->
// Environment Variables); never commit them. DB_API_PASSWORD / DB_PLATFORM_PASSWORD come from `pnpm db:setup-roles`.
import { randomBytes } from 'node:crypto';

console.log(`JWT_ACCESS_SECRET=${randomBytes(48).toString('base64url')}`);
console.log(`CREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
console.error('\nKeep CREDENTIALS_ENCRYPTION_KEY unchanged for the life of a database: saved SIP/ARI passwords are encrypted with it.');
