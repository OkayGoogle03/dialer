import { z } from 'zod';

/** Shared input rules. The API uses the regexes in class-validator DTOs; web forms use the zod schemas. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const HTTPS_URL_RE = /^https:\/\/[^\s]+$/;
export const E164_RE = /^\+[1-9][0-9]{6,14}$/;
export const ROLE_KEY_RE = /^[a-z][a-z_]{1,49}$/;
export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const PERMISSION_KEY_RE = /^[a-z_]+:[a-z_]+$/;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

export const slugSchema = z.string().regex(SLUG_RE, 'Lowercase letters, digits and hyphens (3–63 chars)');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `At least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX)
  .regex(/[a-zA-Z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a digit');
export const hexColorSchema = z.string().regex(HEX_COLOR_RE, 'Use #RRGGBB');
export const httpsUrlSchema = z.string().regex(HTTPS_URL_RE, 'Must be an https:// URL').max(1000);
export const e164Schema = z.string().regex(E164_RE, 'Use E.164 format, e.g. +919876543210');
export const roleKeySchema = z.string().regex(ROLE_KEY_RE, 'Lowercase letters and underscores');
export const domainSchema = z.string().toLowerCase().regex(DOMAIN_RE, 'Invalid domain');

export const loginSchema = z.object({ tenant: slugSchema, email: emailSchema, password: z.string().min(1).max(PASSWORD_MAX) });

export const createTenantSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(200),
  planKey: z.enum(['starter', 'growth', 'enterprise']),
  adminEmail: emailSchema,
  adminName: z.string().trim().min(1).max(200),
  adminPassword: passwordSchema,
});

export const createRoleSchema = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string().regex(PERMISSION_KEY_RE)).max(100),
});

export const teamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  department: z.string().trim().max(100).optional(),
});

/** Returns field → first message, for form display. */
export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = issue.path.join('.') || '_';
    out[k] ??= issue.message;
  }
  return out;
}

export { z };
