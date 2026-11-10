import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsPhone } from '../../../common/utils/phone';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** 10–128 chars with at least one letter and one digit. */
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
export const PASSWORD_MESSAGE = 'Password must be 10–128 characters and include at least one letter and one number';


export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(lower) @IsEmail() @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 10, example: 'a-strong-passphrase-2026' })
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  @ApiProperty({ example: 'Ada' })
  @Transform(trim) @IsString() @Length(1, 80)
  firstName: string;

  @ApiProperty({ example: 'Okafor' })
  @Transform(trim) @IsString() @Length(1, 80)
  lastName: string;

  @ApiPropertyOptional({ example: '+2348031234567', description: 'Phone number: local Nigerian (0803…) or international (+44…)' })
  @IsOptional() @IsPhone()
  phone?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean()
  marketingOptIn?: boolean;
}

export class GuestDto {
  @ApiProperty({ example: 'ada@example.com', description: 'For receipts and order updates' })
  @Transform(lower) @IsEmail() @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Ada' })
  @Transform(trim) @IsString() @Length(1, 80)
  firstName: string;

  @ApiProperty({ example: 'Okafor' })
  @Transform(trim) @IsString() @Length(1, 80)
  lastName: string;

  @ApiProperty({ example: '+2348031234567', description: 'Phone number: local Nigerian (0803…) or international (+44…), for delivery' })
  @IsPhone()
  phone: string;
}

export class UpgradeGuestDto {
  @ApiProperty({ minLength: 10 })
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail()
  email: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Opaque refresh token returned by login/refresh' })
  @IsString() @MinLength(20) @MaxLength(200)
  refreshToken: string;
}

export class VerifyEmailCodeDto {
  @ApiProperty({ example: '123456' }) @IsString() @Matches(/^[0-9]{6}$/, { message: 'The code is 6 digits' })
  code: string;
}

export class VerifyEmailDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200)
  token: string;
}

export class EmailOnlyDto {
  @ApiProperty() @Transform(lower) @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200)
  token: string;

  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128)
  currentPassword: string;

  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

export class TokenResponseDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() accessTokenExpiresIn: number;
  @ApiProperty() refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: string;
  @ApiProperty() tokenType: 'Bearer';
}
