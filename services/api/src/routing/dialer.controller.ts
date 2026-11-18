import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { uuidSchema, z, ZodPipe } from '../master-data/common';
import { DialerService } from './dialer.service';

const callSchema = z.object({ processId: uuidSchema, destination: z.string().trim().min(3).max(32), providerId: uuidSchema.optional() }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0), processId: uuidSchema.optional() }).strict();
const statsSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(1) }).strict();

/** Manual outbound calling. Calls are always explicit: importing caller assignments never places a call. */
@ApiTags('dialer')
@ApiBearerAuth()
@Controller({ path: 'dialer', version: '1' })
export class DialerController {
  constructor(private readonly dialer: DialerService) {}

  /** Minimal process list for the dialer screen: agents can place calls without having master-data access. */
  @Get('processes') @RequirePermissions('calls:make')
  processes(@CurrentUser() u: AuthUser) { return this.dialer.listProcesses(u); }

  @Post('route-preview') @HttpCode(200) @RequirePermissions('calls:make')
  preview(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callSchema)) dto: z.infer<typeof callSchema>) { return this.dialer.previewRoute(u, dto); }

  @Post('calls') @HttpCode(202) @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  place(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callSchema)) dto: z.infer<typeof callSchema>, @Headers('idempotency-key') key: string | undefined, @ReqContext() ctx: RequestContext) {
    return this.dialer.placeCall(u, dto, key, ctx);
  }

  @Post('calls/:id/hangup') @HttpCode(200) @RequirePermissions('calls:make')
  hangup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) { return this.dialer.hangup(u, id, ctx); }

  @Get('calls')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    if (!u.permissions.has('calls:read_own') && !u.permissions.has('calls:read_all')) throw new ForbiddenException('Missing permission: calls:read_own');
    return this.dialer.listCalls(u, q);
  }

  @Get('calls/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!u.permissions.has('calls:read_own') && !u.permissions.has('calls:read_all')) throw new ForbiddenException('Missing permission: calls:read_own');
    return this.dialer.getCall(u, id);
  }

  @Get('stats') @RequirePermissions('calls:read_all')
  stats(@CurrentUser() u: AuthUser, @Query(new ZodPipe(statsSchema)) q: z.infer<typeof statsSchema>) { return this.dialer.stats(u, q.days); }
}
