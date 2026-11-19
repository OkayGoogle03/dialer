import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { CreateUserDto, ListQueryDto, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users:read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListQueryDto) {
    return this.users.list(user, q);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(user, id);
  }

  @Post()
  @RequirePermissions('users:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto, @ReqContext() ctx: RequestContext) {
    return this.users.create(user, dto, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('users:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) {
    return this.users.remove(user, id, ctx);
  }

  @Patch(':id')
  @RequirePermissions('users:manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @ReqContext() ctx: RequestContext) {
    return this.users.update(user, id, dto, ctx);
  }
}
