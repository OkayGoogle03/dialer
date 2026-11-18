import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PASSWORD_MAX, PASSWORD_MIN, ROLE_KEY_RE } from '@dialer/validation';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateUserDto {
  @ApiProperty() @IsEmail() @MaxLength(254)
  email: string;

  @ApiProperty() @IsString() @Length(1, 200)
  displayName: string;

  @ApiProperty({ minLength: PASSWORD_MIN })
  @IsString()
  @Length(PASSWORD_MIN, PASSWORD_MAX)
  @Matches(/[a-zA-Z]/, { message: 'password must contain a letter' })
  @Matches(/[0-9]/, { message: 'password must contain a digit' })
  password: string;

  @ApiProperty({ isArray: true, type: String, example: ['agent'] })
  @IsArray() @ArrayMaxSize(20) @Matches(ROLE_KEY_RE, { each: true })
  roles: string[];

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  teamId?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200)
  displayName?: string;

  @ApiPropertyOptional({ enum: ['active', 'disabled'] }) @IsOptional() @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(ROLE_KEY_RE, { each: true })
  roles?: string[];

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  teamId?: string | null;
}

export class ListQueryDto {
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit = 50;

  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset = 0;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  teamId?: string;
}
