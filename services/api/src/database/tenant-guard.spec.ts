import { assertNoTenantTables, assertTenantScoped, tenantTablesIn, TenantScopeError } from './database';

describe('tenant scope guard', () => {
  it('accepts queries where each tenant table is bound to :tenantId', () => {
    expect(() => assertTenantScoped('SELECT * FROM users WHERE tenant_id = :tenantId')).not.toThrow();
    expect(() => assertTenantScoped(
      'SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = :tenantId WHERE u.tenant_id = :tenantId')).not.toThrow();
    expect(() => assertTenantScoped('INSERT INTO teams (id, tenant_id, name) VALUES (:id, :tenantId, :n)')).not.toThrow();
    expect(() => assertTenantScoped('SELECT `key` FROM permissions')).not.toThrow();
  });

  it('rejects unscoped or under-scoped queries', () => {
    expect(() => assertTenantScoped('SELECT * FROM users')).toThrow(TenantScopeError);
    expect(() => assertTenantScoped('DELETE FROM contacts WHERE id = :id')).toThrow(TenantScopeError);
    expect(() => assertTenantScoped('UPDATE users SET status = :s WHERE id = :id')).toThrow(TenantScopeError);
    expect(() => assertTenantScoped(
      'SELECT * FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.tenant_id = :tenantId')).toThrow(/only 1/);
    expect(() => assertTenantScoped('SELECT * FROM users u, roles r WHERE u.tenant_id = :tenantId AND r.tenant_id = :tenantId')).toThrow(/comma joins/);
  });

  it('counts subqueries and backticked names', () => {
    expect(tenantTablesIn('SELECT (SELECT COUNT(*) FROM `user_roles` x) FROM roles')).toEqual(['user_roles', 'roles']);
  });

  it('global transactions reject tenant tables', () => {
    expect(() => assertNoTenantTables('SELECT * FROM plans')).not.toThrow();
    expect(() => assertNoTenantTables('SELECT * FROM users WHERE tenant_id = :t')).toThrow(TenantScopeError);
  });
});
