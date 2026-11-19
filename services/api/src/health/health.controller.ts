import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/decorators';
import { Database, PlatformDatabase } from '../database/database';
import { EventPublisher } from '../events/publisher';
import { diagnoseDbError } from './db-diagnosis';

@ApiTags('health')
@SkipThrottle()
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly db: Database, private readonly platformDb: PlatformDatabase, @Optional() private readonly publisher?: EventPublisher) {}

  /** Liveness: process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: dependencies reachable. Both database users are checked separately; a failure is reported as an error
   * code plus a hint (never credentials, hosts or raw messages) so a bad deployment setting can be diagnosed from the browser.
   */
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};
    const problems: string[] = [];
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        checks[name] = 'ok';
      } catch (e) {
        checks[name] = 'down';
        problems.push(`${name}: ${diagnoseDbError(e)}`);
      }
    };
    await probe('database', () => this.db.ping());
    await probe('platform', () => this.platformDb.ping());
    if (this.publisher) checks.nats = this.publisher.isConnected() ? 'ok' : 'down';
    if (Object.values(checks).some((v) => v !== 'ok')) {
      throw new ServiceUnavailableException({ message: `Dependency unavailable${problems.length ? ` (${problems.join('; ')})` : ''}`, checks });
    }
    return { status: 'ok', checks };
  }
}
