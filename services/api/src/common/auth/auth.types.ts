/** Claims embedded in the access JWT. tid is the ONLY source of tenant context for authenticated requests. */
export interface AccessClaims {
  sub: string; // user id
  tid: string; // tenant id
  roles: string[];
  perms: string[];
  pa?: boolean; // platform admin
}

export interface AuthUser {
  userId: string;
  tenantId: string;
  roles: string[];
  permissions: Set<string>;
  isPlatformAdmin: boolean;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}
