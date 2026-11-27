import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type RoleView } from '@dialer/shared-types';
import { PERMISSION_KEY_RE, ROLE_KEY_RE } from '@dialer/validation';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, newId, SqlRunner } from '../database/database';
import { assertSubset } from '../rbac/rbac';

export class CreateRoleDto {
  @ApiProperty({ example: 'quality_analyst' }) @Matches(ROLE_KEY_RE) key: string;
  @ApiProperty() @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiProperty({ isArray: true, type: String }) @IsArray() @ArrayMaxSize(100) @Matches(PERMISSION_KEY_RE, { each: true }) permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional({ isArray: true, type: String }) @IsOptional() @IsArray() @ArrayMaxSize(100) @Matches(PERMISSION_KEY_RE, { each: true }) permissions?: string[];
}

const KNOWN = new Set<string>(PERMISSIONS);
function assertKnown(perms: string[]) {
  const unknown = perms.filter((p) => !KNOWN.has(p));
  if (unknown.length) throw new BadRequestException(`Unknown permission: ${unknown.join(', ')}`);
}

@Injectable()
export class RolesService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  permissionsCatalogue() {
    return this.db.withoutTenant((tx) => tx.query<{ key: string; description: string }>('SELECT `key`, description FROM permissions ORDER BY `key`'));
  }

  list(actor: AuthUser) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx));
  }

  async create(actor: AuthUser, dto: CreateRoleDto, ctx: RequestContext) {
    assertKnown(dto.permissions);
    assertSubset(actor, dto.permissions, 'create a role with these permissions');
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const id = newId();
      await tx.execute(`INSERT INTO roles (id, tenant_id, \`key\`, name, description, is_system) VALUES (:id, :tenantId, :k, :n, :d, 0)`,
        { id, k: dto.key, n: dto.name.trim(), d: dto.description ?? null });
      await this.setPermissions(tx, id, dto.permissions);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'role.created', entityType: 'role', entityId: id, metadata: { key: dto.key, permissions: dto.permissions } }, ctx);
      return (await this.load(tx, id))[0];
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateRoleDto, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const role = await this.mustGet(tx, id);
      // built-in roles can be adjusted; Tenant Admin stays as it is, so there is always someone who can put things right
      if (role.key === 'tenant_admin' && role.is_system) throw new BadRequestException('The Tenant Admin role cannot be changed');
      if (dto.permissions) {
        assertKnown(dto.permissions);
        // Must hold both what is removed and what is added (cannot strip permissions you cannot grant back).
        const current = (await this.load(tx, id))[0].permissions;
        assertSubset(actor, [...dto.permissions, ...current], 'change this role');
        await this.setPermissions(tx, id, dto.permissions);
      }
      if (dto.name !== undefined || dto.description !== undefined) {
        await tx.execute(`UPDATE roles SET name = COALESCE(:n, name), description = COALESCE(:d, description) WHERE tenant_id = :tenantId AND id = :id`,
          { id, n: dto.name?.trim() ?? null, d: dto.description ?? null });
      }
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'role.updated', entityType: 'role', entityId: id, metadata: { key: role.key, fields: Object.keys(dto) } }, ctx);
      return (await this.load(tx, id))[0];
    });
  }

  async remove(actor: AuthUser, id: string, ctx: RequestContext) {
    await this.db.withTenant(actor.tenantId, async (tx) => {
      const role = await this.mustGetCustom(tx, id);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM user_roles WHERE tenant_id = :tenantId AND role_id = :id`, { id });
      if (Number(n) > 0) throw new BadRequestException('Role is assigned to users; unassign it first');
      await tx.execute(`UPDATE roles SET record_status = 0, deleted_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'role.deleted', entityType: 'role', entityId: id, metadata: { key: role.key } }, ctx);
    });
  }

  private async mustGetCustom(tx: SqlRunner, id: string) {
    const role = await this.mustGet(tx, id);
    if (role.is_system) throw new BadRequestException('Built-in roles cannot be deleted');
    return role;
  }

  private async mustGet(tx: SqlRunner, id: string) {
    const [role] = await tx.query<{ key: string; is_system: boolean }>(`SELECT \`key\`, is_system FROM roles WHERE tenant_id = :tenantId AND record_status = 1 AND id = :id FOR UPDATE`, { id });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async setPermissions(tx: SqlRunner, roleId: string, perms: string[]) {
    const unique = [...new Set(perms)];
    if (unique.length) {
      const known = await tx.query<{ key: string }>('SELECT `key` FROM permissions WHERE `key` IN (:p)', { p: unique });
      if (known.length !== unique.length) throw new BadRequestException('Unknown permission');
    }
    await tx.execute(`DELETE FROM role_permissions WHERE tenant_id = :tenantId AND role_id = :r`, { r: roleId });
    if (unique.length) {
      await tx.execute(`INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT :tenantId, :r, \`key\` FROM permissions WHERE \`key\` IN (:p)`, { r: roleId, p: unique });
    }
  }

  private async load(tx: SqlRunner, id?: string): Promise<RoleView[]> {
    const roles = await tx.query<{ id: string; key: string; name: string; description: string | null; is_system: boolean; user_count: number }>(
      `SELECT r.id, r.\`key\`, r.name, r.description, r.is_system,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.tenant_id = :tenantId AND ur.role_id = r.id) AS user_count
         FROM roles r WHERE r.tenant_id = :tenantId AND r.record_status = 1 ${id ? 'AND r.id = :id' : ''} ORDER BY r.is_system DESC, r.name`,
      id ? { id } : {},
    );
    if (id && !roles.length) throw new NotFoundException('Role not found');
    const perms = await tx.query<{ role_id: string; permission_key: string }>(
      `SELECT role_id, permission_key FROM role_permissions WHERE tenant_id = :tenantId ${id ? 'AND role_id = :id' : ''} ORDER BY permission_key`, id ? { id } : {});
    return roles.map((r) => ({
      id: r.id, key: r.key, name: r.name, description: r.description, isSystem: !!r.is_system, userCount: Number(r.user_count),
      permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key),
    }));
  }
}

@ApiTags('roles')
@ApiBearerAuth()
@Controller({ version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('roles:manage')
  permissions() {
    return this.roles.permissionsCatalogue();
  }

  @Get('roles')
  @RequirePermissions('users:read')
  list(@CurrentUser() u: AuthUser) {
    return this.roles.list(u);
  }

  @Post('roles')
  @RequirePermissions('roles:manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateRoleDto, @ReqContext() ctx: RequestContext) {
    return this.roles.create(u, dto, ctx);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto, @ReqContext() ctx: RequestContext) {
    return this.roles.update(u, id, dto, ctx);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('roles:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) {
    return this.roles.remove(u, id, ctx);
  }
}
