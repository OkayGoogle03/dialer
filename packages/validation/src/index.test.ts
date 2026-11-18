import { describe, expect, it } from 'vitest';
import { createTenantSchema, DOMAIN_RE, E164_RE, fieldErrors, passwordSchema, SLUG_RE } from './index';

describe('validation', () => {
  it('slugs', () => {
    expect(SLUG_RE.test('acme-co')).toBe(true);
    for (const bad of ['A', 'ab', '-acme', 'acme-', 'ac_me']) expect(SLUG_RE.test(bad)).toBe(false);
  });
  it('e164 and domains', () => {
    expect(E164_RE.test('+919876543210')).toBe(true);
    expect(E164_RE.test('09876543210')).toBe(false);
    expect(DOMAIN_RE.test('calls.acme.com')).toBe(true);
    expect(DOMAIN_RE.test('localhost')).toBe(false);
  });
  it('password policy', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('longpasswordnodigit').success).toBe(false);
    expect(passwordSchema.safeParse('longpassword123').success).toBe(true);
  });
  it('maps errors to fields', () => {
    const r = createTenantSchema.safeParse({ slug: 'X', name: '', planKey: 'gold', adminEmail: 'no', adminName: 'a', adminPassword: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrors(r.error)).sort()).toEqual(['adminEmail', 'adminPassword', 'name', 'planKey', 'slug']);
  });
});
