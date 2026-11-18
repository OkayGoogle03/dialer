import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { TeamView } from '@dialer/shared-types';
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, newId, Row, SqlRunner } from '../database/database';

export class CreateTeamDto {
  @ApiProperty() @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) department?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() leaderUserId?: string;
}

export class UpdateTeamDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100) department?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() leaderUserId?: string | null;
}

export class SetMembersDto {
  @ApiProperty({ isArray: true, type: String }) @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) userIds: string[];
}

const TEAM_SQL = `
  SELECT t.id, t.name, t.department, t.leader_user_id, t.created_at,
         (SELECT COUNT(*) FROM users u WHERE u.tenant_id = :tenantId AND u.team_id = t.id AND u.deleted_at IS NULL) AS member_count
    FROM teams t WHERE t.tenant_id = :tenantId AND t.deleted_at IS NULL`;

const toView = (r: Row): TeamView => ({
  id: r.id, name: r.name, department: r.department, leaderUserId: r.leader_user_id, memberCount: Number(r.member_count), createdAt: r.created_at.toISOString(),
});

@Injectable()
export class TeamsService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  list(actor: AuthUser) {
    return this.db.withTenant(actor.tenantId, async (tx) => (await tx.query(`${TEAM_SQL} ORDER BY t.name`)).map(toView));
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const team = await this.load(tx, id);
      const members = await tx.query(`SELECT id, display_name AS displayName, email FROM users WHERE tenant_id = :tenantId AND team_id = :id AND deleted_at IS NULL ORDER BY display_name`, { id });
      return { ...team, members };
    });
  }

  create(actor: AuthUser, dto: CreateTeamDto, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const id = newId();
      if (dto.leaderUserId) await this.assertUser(tx, dto.leaderUserId);
      await tx.execute(`INSERT INTO teams (id, tenant_id, name, department, leader_user_id) VALUES (:id, :tenantId, :n, :d, :l)`,
        { id, n: dto.name.trim(), d: dto.department?.trim() || null, l: dto.leaderUserId ?? null });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'team.created', entityType: 'team', entityId: id, metadata: { name: dto.name } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: UpdateTeamDto, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id);
      if (dto.leaderUserId) await this.assertUser(tx, dto.leaderUserId);
      const sets: string[] = [];
      const p: Record<string, unknown> = { id };
      if (dto.name !== undefined) { sets.push('name = :n'); p.n = dto.name.trim(); }
      if (dto.department !== undefined) { sets.push('department = :d'); p.d = dto.department?.trim() || null; }
      if (dto.leaderUserId !== undefined) { sets.push('leader_user_id = :l'); p.l = dto.leaderUserId; }
      if (sets.length) await tx.execute(`UPDATE teams SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'team.updated', entityType: 'team', entityId: id, metadata: { fields: Object.keys(dto) } }, ctx);
      return this.load(tx, id);
    });
  }

  /** Replaces the team's membership. Users move from any previous team. */
  setMembers(actor: AuthUser, id: string, userIds: string[], ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id);
      const unique = [...new Set(userIds)];
      if (unique.length) {
        const found = await tx.query(`SELECT id FROM users WHERE tenant_id = :tenantId AND id IN (:ids) AND deleted_at IS NULL`, { ids: unique });
        if (found.length !== unique.length) throw new BadRequestException('One or more users not found');
      }
      await tx.execute(`UPDATE users SET team_id = NULL WHERE tenant_id = :tenantId AND team_id = :id`, { id });
      if (unique.length) await tx.execute(`UPDATE users SET team_id = :id WHERE tenant_id = :tenantId AND id IN (:ids)`, { id, ids: unique });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'team.members_set', entityType: 'team', entityId: id, metadata: { count: unique.length } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id);
      await tx.execute(`UPDATE users SET team_id = NULL WHERE tenant_id = :tenantId AND team_id = :id`, { id });
      await tx.execute(`UPDATE teams SET deleted_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'team.deleted', entityType: 'team', entityId: id }, ctx);
    });
  }

  private async load(tx: SqlRunner, id: string) {
    const [row] = await tx.query(`${TEAM_SQL} AND t.id = :id`, { id });
    if (!row) throw new NotFoundException('Team not found');
    return toView(row);
  }

  private async assertUser(tx: SqlRunner, userId: string) {
    const rows = await tx.query(`SELECT 1 FROM users WHERE tenant_id = :tenantId AND id = :u AND deleted_at IS NULL`, { u: userId });
    if (!rows.length) throw new BadRequestException('Leader user not found');
  }
}

@ApiTags('teams')
@ApiBearerAuth()
@Controller({ path: 'teams', version: '1' })
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get() @RequirePermissions('users:read')
  list(@CurrentUser() u: AuthUser) { return this.teams.list(u); }

  @Get(':id') @RequirePermissions('users:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.teams.get(u, id); }

  @Post() @RequirePermissions('teams:manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTeamDto, @ReqContext() ctx: RequestContext) { return this.teams.create(u, dto, ctx); }

  @Patch(':id') @RequirePermissions('teams:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeamDto, @ReqContext() ctx: RequestContext) { return this.teams.update(u, id, dto, ctx); }

  @Put(':id/members') @RequirePermissions('teams:manage')
  setMembers(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetMembersDto, @ReqContext() ctx: RequestContext) { return this.teams.setMembers(u, id, dto.userIds, ctx); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('teams:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) { return this.teams.remove(u, id, ctx); }
}
