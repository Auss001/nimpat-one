import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { NG_PHONE } from '../auth/dto/auth.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 80) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 80) lastName?: string;
  @ApiPropertyOptional({ example: '+2348031234567' })
  @IsOptional() @Matches(NG_PHONE, { message: 'phone must be a Nigerian mobile number in +234 format' })
  phone?: string;
  @ApiPropertyOptional({ example: '1990-04-12' }) @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Home' }) @IsOptional() @Transform(trim) @IsString() @Length(1, 40) label?: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(2, 120) recipientName: string;
  @ApiProperty({ example: '+2348031234567' })
  @Matches(NG_PHONE, { message: 'phone must be a Nigerian mobile number in +234 format' })
  phone: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(3, 200) line1: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 200) line2?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 200) landmark?: string;
  @ApiProperty({ example: 'Wuye' }) @Transform(trim) @IsString() @Length(2, 80) city: string;
  @ApiPropertyOptional({ example: 'AMAC' }) @IsOptional() @Transform(trim) @IsString() @Length(2, 80) lga?: string;
  @ApiProperty({ example: 'FCT' }) @Transform(trim) @IsString() @Length(2, 40) state: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
