import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import type { Params } from '../database/database';

export { z };

/** Validates request bodies/queries with zod. Unknown keys must be rejected by the schema (.strict()). */
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: z.ZodTypeAny) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException({ message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    }
    return r.data;
  }
}

export const nameSchema = z.string().trim().min(1).max(100).transform((s) => s.replace(/\s+/g, ' '));
export const uuidSchema = z.string().uuid();
export const intRange = (min: number, max: number) => z.number().int().min(min).max(max);

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    search: z.string().trim().max(100).optional(),
    status: z.string().trim().max(24).optional(),
  })
  .strict();
export type ListQuery = z.infer<typeof listQuerySchema>;

export const likePattern = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Normalised key for case-insensitive name matching across Excel rows and master data. */
export const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function slugCode(name: string): string {
  const s = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'PROCESS';
}

export const DID_RE = /^\+?[0-9]{6,15}$/;
export const PREFIX_RE = /^[0-9]{1,6}$/;
export const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export const normalizeDid = (s: string) => s.replace(/^\+/, '');

/** Builds "col = :param" fragments for the supplied (defined) DTO fields; values are bound, never interpolated. */
export function buildSet(map: Record<string, string>, dto: Record<string, unknown>, params: Params, transform: Record<string, (v: any) => unknown> = {}): string[] {
  const sets: string[] = [];
  for (const [field, col] of Object.entries(map)) {
    const v = dto[field];
    if (v === undefined) continue;
    params[`p_${field}`] = transform[field] ? transform[field](v) : v;
    sets.push(`${col} = :p_${field}`);
  }
  return sets;
}

export const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export const retryPolicySchema = z.object({ maxAttempts: intRange(1, 5).default(2), backoffMs: intRange(0, 60_000).default(0) }).strict();

export const CODECS = ['ulaw', 'alaw', 'g722', 'opus', 'g729', 'gsm'] as const;
