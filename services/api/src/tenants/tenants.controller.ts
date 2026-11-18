import { Body, Controller, Get, NotFoundException, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { HEX_COLOR_RE, HTTPS_URL_RE, SLUG_RE } from '@dialer/validation';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, Public, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database } from '../database/database';

export class UpdateBrandingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) productName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HTTPS_URL_RE) @MaxLength(1000) logoUrl?: string | null;
  @ApiPropertyOptional() @IsOptional() @Matches(HTTPS_URL_RE) @MaxLength(1000) faviconUrl?: string | null;
  @ApiPropertyOptional() @IsOptional() @Matches(HEX_COLOR_RE) primaryColor?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HEX_COLOR_RE) secondaryColor?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HEX_COLOR_RE) accentColor?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) supportEmail?: string;
}

export class PublicBrandingQuery {
  @ApiProperty() @Matches(SLUG_RE) tenant: string;
}

const BRANDING_COLS = `product_name AS productName, logo_url AS logoUrl, favicon_url AS faviconUrl,
  primary_color AS primaryColor, secondary_color AS secondaryColor, accent_color AS accentColor, support_email AS supportEmail`;

const BRANDING_FIELDS: Record<string, string> = {
  productName: 'product_name', logoUrl: 'logo_url', faviconUrl: 'favicon_url', primaryColor: 'primary_color',
  secondaryColor: 'secondary_color', accentColor: 'accent_color', supportEmail: 'support_email',
};

@ApiTags('tenants')
@Controller({ version: '1' })
export class TenantsController {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  /** Unauthenticated: branding for the login page. Presentation fields only. */
  @Public()
  @Get('public/branding')
  async publicBranding(@Query() q: PublicBrandingQuery) {
    const t = await this.db.resolveTenant({ slug: q.tenant });
    if (!t) throw new NotFoundException('Tenant not found');
    return { tenantName: t.name, ...((await this.db.publicBranding(t.id)) ?? {}) };
  }

  @ApiBearerAuth()
  @Get('tenants/current')
  @RequirePermissions('tenant:read')
  current(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.query(
        `SELECT id, slug, name, status, custom_domain AS customDomain, timezone, country_code AS countryCode, created_at AS createdAt
           FROM tenants WHERE id = :tenantId`);
      return row;
    });
  }

  @ApiBearerAuth()
  @Get('branding')
  branding(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, async (tx) => (await tx.query(`SELECT ${BRANDING_COLS} FROM tenant_branding WHERE tenant_id = :tenantId`))[0]);
  }

  @ApiBearerAuth()
  @Put('branding')
  @RequirePermissions('branding:manage')
  updateBranding(@CurrentUser() user: AuthUser, @Body() dto: UpdateBrandingDto, @ReqContext() ctx: RequestContext) {
    const sets: string[] = [];
    const params: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(BRANDING_FIELDS)) {
      const v = (dto as Record<string, unknown>)[k];
      if (v !== undefined) {
        params[k] = v;
        sets.push(`${col} = :${k}`);
      }
    }
    return this.db.withTenant(user.tenantId, async (tx) => {
      if (sets.length) {
        await tx.execute(`UPDATE tenant_branding SET ${sets.join(', ')} WHERE tenant_id = :tenantId`, params);
        await this.audit.log(tx, { actorUserId: user.userId, action: 'branding.updated', entityType: 'tenant', entityId: user.tenantId, metadata: { fields: Object.keys(params) } }, ctx);
      }
      return (await tx.query(`SELECT ${BRANDING_COLS} FROM tenant_branding WHERE tenant_id = :tenantId`))[0];
    });
  }
}
