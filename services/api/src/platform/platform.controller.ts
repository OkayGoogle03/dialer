import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext } from '../common/auth/decorators';
import { CreateTenantDto, ListTenantsQuery, SuspendTenantDto, UpdateTenantDto } from './platform.dto';
import { PlatformAdminGuard } from './platform.guard';
import { PlatformService } from './platform.service';

/** Super Admin API. Every route requires PlatformAdminGuard (on top of the global AuthGuard). */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller({ path: 'platform/tenants', version: '1' })
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list(@Query() q: ListTenantsQuery) {
    return this.platform.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.get(id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTenantDto, @ReqContext() ctx: RequestContext) {
    return this.platform.create(user, dto, ctx);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto, @ReqContext() ctx: RequestContext) {
    return this.platform.update(user, id, dto, ctx);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendTenantDto, @ReqContext() ctx: RequestContext) {
    return this.platform.suspend(user, id, dto.reason, ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) {
    return this.platform.reactivate(user, id, ctx);
  }
}
