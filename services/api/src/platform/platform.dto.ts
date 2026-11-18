import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOMAIN_RE, PASSWORD_MAX, PASSWORD_MIN, SLUG_RE } from '@dialer/validation';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

export const PLAN_KEYS = ['starter', 'growth', 'enterprise'] as const;

export class CreateTenantDto {
  @ApiProperty({ example: 'acme' }) @Matches(SLUG_RE) slug: string;
  @ApiProperty() @IsString() @Length(1, 200) name: string;
  @ApiProperty({ enum: PLAN_KEYS }) @IsIn(PLAN_KEYS) planKey: string;
  @ApiProperty() @IsEmail() @MaxLength(254) adminEmail: string;
  @ApiProperty() @IsString() @Length(1, 200) adminName: string;
  @ApiProperty({ minLength: PASSWORD_MIN })
  @IsString() @Length(PASSWORD_MIN, PASSWORD_MAX) @Matches(/[a-zA-Z]/, { message: 'password must contain a letter' }) @Matches(/[0-9]/, { message: 'password must contain a digit' })
  adminPassword: string;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(DOMAIN_RE) customDomain?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @ApiPropertyOptional({ enum: PLAN_KEYS }) @IsOptional() @IsIn(PLAN_KEYS) planKey?: string;
  @ApiPropertyOptional({ description: 'Per-tenant concurrent call cap override' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) maxConcurrentCalls?: number;
}

export class SuspendTenantDto {
  @ApiProperty() @IsString() @Length(3, 500) reason: string;
}

export class ListTenantsQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: ['active', 'suspended', 'closed'] }) @IsOptional() @IsIn(['active', 'suspended', 'closed']) status?: string;
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset = 0;
}
