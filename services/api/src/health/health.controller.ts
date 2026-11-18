import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/decorators';
import { Database } from '../database/database';
import { EventPublisher } from '../events/publisher';

@ApiTags('health')
@SkipThrottle()
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly db: Database, @Optional() private readonly publisher?: EventPublisher) {}

  /** Liveness: process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Redis check added when the Redis client is wired (Phase 2). */
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};
    try {
      await this.db.ping();
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    if (this.publisher) checks.nats = this.publisher.isConnected() ? 'ok' : 'down';
    if (Object.values(checks).some((v) => v !== 'ok')) throw new ServiceUnavailableException({ message: 'Dependency unavailable', checks });
    return { status: 'ok', checks };
  }
}
