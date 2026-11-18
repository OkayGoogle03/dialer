import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'acme', description: 'Tenant slug (or resolved from custom domain by the web app)' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
  tenant: string;

  @ApiProperty({ example: 'admin@acme.test' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  password: string;

  @ApiPropertyOptional({ enum: ['cookie', 'body'], description: 'Web uses an httpOnly cookie; desktop requests the token in the body.' })
  @IsOptional()
  @IsIn(['cookie', 'body'])
  refreshTokenDelivery?: 'cookie' | 'body';
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Required when not using the refresh cookie' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;

  @ApiPropertyOptional({ enum: ['cookie', 'body'] })
  @IsOptional()
  @IsIn(['cookie', 'body'])
  refreshTokenDelivery?: 'cookie' | 'body';
}
