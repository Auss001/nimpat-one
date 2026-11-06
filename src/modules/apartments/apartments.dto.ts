import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ListingStatus, ReservationStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { MinorAmount } from '../catalog/catalog.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class PropertyQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'Abuja' }) @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional({ example: '2026-12-20' }) @IsOptional() @Matches(DATE) checkIn?: string;
  @ApiPropertyOptional({ example: '2026-12-23' }) @IsOptional() @Matches(DATE) checkOut?: string;
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) guests?: number;
}

export class StayQueryDto {
  @ApiProperty({ example: '2026-12-20' }) @Matches(DATE, { message: 'checkIn must be YYYY-MM-DD' }) checkIn: string;
  @ApiProperty({ example: '2026-12-23' }) @Matches(DATE, { message: 'checkOut must be YYYY-MM-DD' }) checkOut: string;
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) guests?: number;
}

export class CalendarQueryDto {
  @ApiProperty({ example: '2026-12-01' }) @Matches(DATE) from: string;
  @ApiProperty({ example: '2027-01-31' }) @Matches(DATE) to: string;
}

export class CreateReservationDto {
  @ApiProperty() @IsUUID() unitId: string;
  @ApiProperty({ example: '2026-12-20' }) @Matches(DATE) checkIn: string;
  @ApiProperty({ example: '2026-12-23' }) @Matches(DATE) checkOut: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(30) guests: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) guestNote?: string;
}

export class CancelReservationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) reason?: string;
}

export class ReservationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReservationStatus }) @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
}

export class AdminReservationQueryDto extends ReservationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() propertyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ description: 'Stays overlapping this date onward' }) @IsOptional() @Matches(DATE) from?: string;
}

export class UpdateReservationStatusDto {
  @ApiProperty({ enum: ['CHECKED_IN', 'COMPLETED', 'CANCELLED'] }) @IsEnum(ReservationStatus) status: ReservationStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) note?: string;
}

export class CreatePropertyDto {
  @ApiProperty() @IsString() @Length(2, 120) name: string;
  @ApiProperty() @Matches(SLUG) @Length(2, 120) slug: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiProperty() @IsString() @Length(3, 200) addressLine: string;
  @ApiProperty({ example: 'Abuja' }) @IsString() @Length(2, 80) city: string;
  @ApiProperty({ example: 'FCT' }) @IsString() @Length(2, 40) state: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional({ example: '14:00' }) @IsOptional() @Matches(TIME) checkInTime?: string;
  @ApiPropertyOptional({ example: '12:00' }) @IsOptional() @Matches(TIME) checkOutTime?: string;
  @ApiPropertyOptional({ enum: ListingStatus }) @IsOptional() @IsEnum(ListingStatus) status?: ListingStatus;
}

export class UpdatePropertyDto extends PartialType(CreatePropertyDto) {}

export class CreateUnitDto {
  @ApiProperty({ example: 'A-101' }) @IsString() @Length(1, 40) code: string;
  @ApiProperty({ example: 'Two-bedroom executive apartment' }) @IsString() @Length(2, 120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiProperty() @IsInt() @Min(0) @Max(20) bedrooms: number;
  @ApiProperty({ example: 3.5 }) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(20) bathrooms: number;
  @ApiProperty() @IsInt() @Min(1) @Max(30) maxGuests: number;
  @ApiProperty({ description: 'Nightly rate in kobo' }) @MinorAmount() @IsInt() @Min(1) nightlyRateMinor: number;
  @ApiPropertyOptional({ description: 'Refundable caution deposit in kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) cautionDepositMinor?: number;
  @ApiPropertyOptional({ description: 'One-off cleaning fee in kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) cleaningFeeMinor?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) minNights?: number;
  @ApiPropertyOptional({ default: 90 }) @IsOptional() @IsInt() @Min(1) @Max(365) maxNights?: number;
  @ApiPropertyOptional({ enum: ListingStatus }) @IsOptional() @IsEnum(ListingStatus) status?: ListingStatus;
}

export class UpdateUnitDto extends PartialType(CreateUnitDto) {}

export class CreateBlackoutDto {
  @ApiProperty() @Matches(DATE) startDate: string;
  @ApiProperty({ description: 'Exclusive end date' }) @Matches(DATE) endDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) reason?: string;
}
