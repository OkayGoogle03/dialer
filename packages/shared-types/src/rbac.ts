/** Permission catalogue. Must match the `permissions` rows seeded by database/migrations (asserted by API tests). */
export const PERMISSIONS = [
  'tenant:read',
  'tenant:manage',
  'branding:manage',
  'users:read',
  'users:manage',
  'roles:manage',
  'teams:manage',
  'extensions:manage',
  'sip_providers:manage',
  'calls:make',
  'calls:read_own',
  'calls:read_all',
  'calls:monitor',
  'recordings:read',
  'recordings:export',
  'contacts:read',
  'contacts:manage',
  'campaigns:read',
  'campaigns:manage',
  'queues:manage',
  'reports:read',
  'reports:export',
  'ai_agents:manage',
  'knowledge:manage',
  'billing:read',
  'billing:manage',
  'audit:read',
  'master_data:read',
  'processes:manage',
  'call_servers:manage',
  'caller_import:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ['tenant_admin', 'supervisor', 'team_leader', 'agent', 'auditor', 'billing_admin'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  permissions: readonly Permission[];
}

/** Default roles seeded into every new tenant. System roles cannot be edited or deleted by tenants. */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { key: 'tenant_admin', name: 'Tenant Admin', permissions: PERMISSIONS },
  {
    key: 'supervisor',
    name: 'Supervisor',
    permissions: ['tenant:read', 'users:read', 'calls:make', 'calls:read_all', 'calls:monitor', 'recordings:read', 'contacts:read', 'contacts:manage', 'campaigns:read', 'campaigns:manage', 'queues:manage', 'reports:read', 'reports:export', 'master_data:read', 'caller_import:manage'],
  },
  {
    key: 'team_leader',
    name: 'Team Leader',
    permissions: ['tenant:read', 'users:read', 'calls:make', 'calls:read_all', 'calls:monitor', 'recordings:read', 'contacts:read', 'campaigns:read', 'reports:read', 'master_data:read'],
  },
  { key: 'agent', name: 'Agent', permissions: ['calls:make', 'calls:read_own', 'contacts:read', 'campaigns:read'] },
  { key: 'auditor', name: 'Auditor', permissions: ['tenant:read', 'users:read', 'calls:read_all', 'recordings:read', 'reports:read', 'audit:read'] },
  { key: 'billing_admin', name: 'Billing Admin', permissions: ['tenant:read', 'billing:read', 'billing:manage', 'reports:read'] },
];
