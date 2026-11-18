import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, Public, ReqContext } from '../common/auth/decorators';
import { APP_CONFIG, AppConfig } from '../config/env';
import { Database } from '../database/database';
import { AuthService, TokenPair } from './auth.service';
import { LoginDto, RefreshDto } from './dto/auth.dto';

export const REFRESH_COOKIE = 'dialer_rt';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto.tenant, dto.email, dto.password, ctx);
    return this.deliver(tokens, dto.refreshTokenDelivery ?? 'cookie', res);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const fromCookie = readCookie(req, REFRESH_COOKIE);
    const raw = dto.refreshToken ?? fromCookie ?? '';
    const tokens = await this.auth.refresh(raw, ctx);
    return this.deliver(tokens, dto.refreshToken ? (dto.refreshTokenDelivery ?? 'body') : 'cookie', res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @ReqContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(dto.refreshToken ?? readCookie(req, REFRESH_COOKIE), ctx);
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @ApiBearerAuth()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.query<{ id: string; email: string; display_name: string; status: string }>(
        `SELECT id, email, display_name, status FROM users WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL`, { id: user.userId });
      const [tenant] = await tx.query(`SELECT id, slug, name FROM tenants WHERE id = :tenantId`);
      const [branding] = await tx.query(
        `SELECT product_name AS productName, logo_url AS logoUrl, primary_color AS primaryColor, secondary_color AS secondaryColor,
                accent_color AS accentColor FROM tenant_branding WHERE tenant_id = :tenantId`);
      return {
        user: row && { id: row.id, email: row.email, displayName: row.display_name, status: row.status },
        tenant,
        branding: branding ?? null,
        roles: user.roles,
        permissions: [...user.permissions].sort(),
        isPlatformAdmin: user.isPlatformAdmin,
      };
    });
  }

  private deliver(tokens: TokenPair, mode: 'cookie' | 'body', res: Response) {
    const { refreshToken, ...rest } = tokens;
    if (mode === 'body') return { ...rest, refreshToken };
    res.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: this.config.nodeEnv === 'production',
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: new Date(tokens.refreshTokenExpiresAt),
    });
    return rest;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
