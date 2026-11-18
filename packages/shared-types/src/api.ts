/** Response shapes of the /api/v1 REST API shared by web, desktop and tests. */

export interface ApiErrorBody {
  error: { status: number; code: string; message: string; details?: unknown; correlationId?: string };
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface TokenResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken?: string;
  refreshTokenExpiresAt: string;
}

export interface Branding {
  productName: string;
  logoUrl: string | null;
  faviconUrl?: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  supportEmail?: string | null;
}

export interface Me {
  user: { id: string; email: string; displayName: string; status: string };
  tenant: { id: string; slug: string; name: string };
  branding: Branding | null;
  roles: string[];
  permissions: string[];
  isPlatformAdmin: boolean;
}

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled' | 'invited';
  roles: string[];
  teamId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

export interface TeamView {
  id: string;
  name: string;
  department: string | null;
  leaderUserId: string | null;
  memberCount: number;
  createdAt: string;
}

export type TenantStatus = 'active' | 'suspended' | 'closed';

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  isPlatform: boolean;
  customDomain: string | null;
  planKey: string | null;
  userCount: number;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}
