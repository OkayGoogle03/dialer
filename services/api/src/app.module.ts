import { DynamicModule, Global, Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown, Optional } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Logger } from 'pino';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './common/auth/auth.guard';
import { UserAwareThrottlerGuard } from './common/auth/throttler.guard';
import { TenantStatusService } from './common/auth/tenant-status.service';
import { ErrorFilter, LOGGER } from './common/http/error.filter';
import { requestLoggingMiddleware } from './common/logging/logger';
import { APP_CONFIG, AppConfig } from './config/env';
import { Database, PlatformDatabase } from './database/database';
import { OutboxService } from './events/outbox.service';
import { EventPublisher } from './events/publisher';
import { HealthController } from './health/health.controller';
import { PlatformController } from './platform/platform.controller';
import { PlatformAdminGuard } from './platform/platform.guard';
import { PlatformService } from './platform/platform.service';
import { RolesController, RolesService } from './roles/roles.controller';
import { TeamsController, TeamsService } from './teams/teams.controller';
import { TenantsController } from './tenants/tenants.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { SecretsService } from './common/crypto/secrets.service';
import { AssignmentsController, AssignmentsService } from './master-data/assignments';
import { CallServersController, CallServersService } from './master-data/call-servers';
import { ConnectivityService } from './master-data/connectivity.service';
import { DidsController, DidsService } from './master-data/dids';
import { ProcessesController, ProcessesService } from './master-data/processes';
import { ProvidersController, ProvidersService } from './master-data/providers';
import { TrunksController, TrunksService } from './master-data/trunks';
import { AriTelephonyAdapter } from './telephony/ari-adapter';
import { TelephonyAdapter } from './telephony/telephony-adapter';
import { DialerController } from './routing/dialer.controller';
import { DialerService } from './routing/dialer.service';
import { CallerImportController } from './caller-import/caller-import.controller';
import { CallerImportService } from './caller-import/caller-import.service';
import { AppInfoController } from './app-info/app-info.controller';
import { CallListsController, CallListsService } from './call-lists/call-lists';
import { SoftphoneController, SoftphoneService } from './softphone/softphone';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  platformDb: PlatformDatabase;
  logger: Logger;
  publisher?: EventPublisher;
  /** Defaults to the real ARI adapter; tests inject a scripted mock. */
  telephony?: TelephonyAdapter;
}

@Global()
@Module({})
class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformDatabase) private readonly platformDb: PlatformDatabase,
    @Optional() @Inject(EventPublisher) private readonly publisher?: EventPublisher,
  ) {}

  static register(d: AppDeps): DynamicModule {
    const providers = [
      { provide: APP_CONFIG, useValue: d.config },
      { provide: Database, useValue: d.db },
      { provide: PlatformDatabase, useValue: d.platformDb },
      { provide: LOGGER, useValue: d.logger },
      ...(d.publisher ? [{ provide: EventPublisher, useValue: d.publisher }] : []),
    ];
    return { module: CoreModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown() {
    await this.publisher?.close().catch(() => undefined);
    await this.db.close();
    await this.platformDb.close();
  }
}

export function createAppModule(d: AppDeps): DynamicModule {
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(requestLoggingMiddleware(d.logger)).forRoutes('*');
    }
  }
  return {
    module: AppModule,
    imports: [
      CoreModule.register(d),
      JwtModule.register({ secret: d.config.jwtAccessSecret, signOptions: { algorithm: 'HS256', issuer: 'project-dialer' }, verifyOptions: { issuer: 'project-dialer' } }),
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    ],
    controllers: [HealthController, AuthController, UsersController, TenantsController, RolesController, TeamsController, PlatformController,
      ProvidersController, TrunksController, DidsController, ProcessesController, CallServersController, AssignmentsController, CallerImportController, DialerController, SoftphoneController, AppInfoController, CallListsController],
    providers: [
      AuditService,
      OutboxService,
      TenantStatusService,
      AuthService,
      UsersService,
      RolesService,
      TeamsService,
      PlatformService,
      PlatformAdminGuard,
      SecretsService, ConnectivityService,
      ProvidersService, TrunksService, DidsService, ProcessesService, CallServersService, AssignmentsService, CallerImportService, DialerService, SoftphoneService, CallListsService,
      { provide: TelephonyAdapter, useFactory: (c: ConnectivityService) => d.telephony ?? new AriTelephonyAdapter(c), inject: [ConnectivityService] },
      { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  };
}
