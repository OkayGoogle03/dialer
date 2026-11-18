import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { Database } from '../../database/database';

/**
 * Caches tenant status so a suspended tenant's still-valid access tokens stop working within
 * TENANT_STATUS_CACHE_SECONDS (default 15s). Platform actions invalidate the local entry immediately.
 * TODO(Phase 2, depends on Redis wiring): broadcast invalidation across API instances via Redis pub/sub.
 */
@Injectable()
export class TenantStatusService {
  private readonly cache = new Map<string, { status: string; expires: number }>();

  constructor(private readonly db: Database, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async status(tenantId: string): Promise<string | null> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.status;
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.query<{ status: string }>(`SELECT status FROM tenants WHERE id = :tenantId AND deleted_at IS NULL`));
    const status = rows[0]?.status ?? null;
    if (status) this.cache.set(tenantId, { status, expires: Date.now() + this.config.tenantStatusCacheSeconds * 1000 });
    return status;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
