import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { DeliveryStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { MinorAmount } from '../catalog/catalog.dto';
import { DivisionsService } from '../divisions/divisions.service';
import { DeliveryService } from './delivery.service';

class DeliveryQuoteQueryDto {
  @ApiProperty({ example: 'water-drinks-wines' }) @IsString() division: string;
  @ApiProperty({ example: 'FCT' }) @IsString() @Length(2, 40) state: string;
  @ApiProperty({ example: 'Wuye' }) @IsString() @Length(2, 80) city: string;
  @ApiPropertyOptional({ description: 'Basket subtotal in kobo, to evaluate free-delivery thresholds' })
  @IsOptional() @MinorAmount() @IsInt() @Min(0) subtotalMinor?: number;
  @ApiPropertyOptional({ description: 'Number of items, for zones that charge larger orders differently' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) quantity?: number;
}

class CreateZoneDto {
  @ApiProperty({ example: 'water-drinks-wines' }) @IsString() division: string;
  @ApiProperty({ example: 'Abuja Central' }) @IsString() @Length(2, 80) name: string;
  @ApiProperty({ example: 'FCT' }) @IsString() @Length(2, 40) state: string;
  @ApiPropertyOptional({ type: [String], description: 'Cities covered; empty = whole state' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) cities?: string[];
  @ApiProperty({ description: 'Fee in kobo' }) @MinorAmount() @IsInt() @Min(0) feeMinor: number;
  @ApiPropertyOptional({ description: 'Free delivery when subtotal ≥ this (kobo)' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) freeAboveMinor?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) estimatedHours?: number;
  @ApiPropertyOptional({ description: 'Fee for larger orders (kobo), charged from bulkFromQty items' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) bulkFeeMinor?: number | null;
  @ApiPropertyOptional({ description: 'Number of items from which the larger-order fee applies' }) @IsOptional() @IsInt() @Min(1) bulkFromQty?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ description: 'Allow pay on delivery in this zone (the division payment policy must allow it too)' }) @IsOptional() @IsBoolean() payOnDeliveryEnabled?: boolean;
}

class UpdateZoneDto extends PartialType(CreateZoneDto) {}

class DeliveryListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DeliveryStatus }) @IsOptional() @IsEnum(DeliveryStatus) status?: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() divisionId?: string;
}

class UpdateDeliveryDto {
  @ApiPropertyOptional({ enum: DeliveryStatus }) @IsOptional() @IsEnum(DeliveryStatus) status?: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledFor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) failureReason?: string;
}

@ApiTags('Delivery')
@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly divisions: DivisionsService,
  ) {}

  @Public()
  @Get('zones')
  @ApiOperation({ summary: 'Active delivery zones and fees for a division' })
  async zones(@Query('division') division: string) {
    const d = await this.divisions.resolve(division ?? 'water-drinks-wines');
    return this.delivery.listZones(d.id);
  }

  @Public()
  @Get('areas')
  @ApiOperation({ summary: 'Abuja areas for the address form, with this shop\'s delivery fee for each' })
  async areas(@Query('division') division: string) {
    const d = await this.divisions.resolve(division ?? 'water-drinks-wines');
    return this.delivery.abujaAreas(d.id);
  }

  @Public()
  @Get('quote')
  @ApiOperation({ summary: 'Delivery charge for a location (calculated on the server)' })
  async quote(@Query() q: DeliveryQuoteQueryDto) {
    const d = await this.divisions.resolve(q.division);
    return this.delivery.quote(d.id, q, BigInt(q.subtotalMinor ?? 0), q.quantity ?? 0);
  }
}

@ApiTags('Admin · Delivery')
@Controller('admin/delivery')
export class AdminDeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly divisions: DivisionsService,
  ) {}

  @Get('zones')
  @RequirePermissions(P.deliveriesManage)
  async zones(@CurrentUser() user: AuthUser, @Query('division') division: string) {
    const d = await this.divisions.resolve(division ?? 'water-drinks-wines');
    user.assertCan(P.deliveriesManage, d.id);
    return this.delivery.listZones(d.id, true);
  }

  @Post('abuja-rings')
  @RequirePermissions(P.deliveriesManage)
  @ApiOperation({ summary: 'Set this shop\'s Abuja fees in rings around Wuye (free, ₦5,000, ₦7,500, ₦10,000)' })
  async abujaRings(@CurrentUser() user: AuthUser, @Body('division') division: string) {
    const d = await this.divisions.resolve(division);
    return this.delivery.setupAbujaRings(user, d.id);
  }

  @Post('zones')
  @RequirePermissions(P.deliveriesManage)
  @ApiOperation({ summary: 'Create a delivery zone with its fee' })
  async createZone(@CurrentUser() user: AuthUser, @Body() dto: CreateZoneDto) {
    const d = await this.divisions.resolve(dto.division);
    const { division, feeMinor, freeAboveMinor, bulkFeeMinor, ...rest } = dto;
    return this.delivery.createZone(user, d.id, {
      ...rest,
      feeMinor: BigInt(feeMinor),
      freeAboveMinor: freeAboveMinor !== undefined ? BigInt(freeAboveMinor) : undefined,
      bulkFeeMinor: bulkFeeMinor === undefined ? undefined : bulkFeeMinor === null ? null : BigInt(bulkFeeMinor),
    });
  }

  @Patch('zones/:id')
  @RequirePermissions(P.deliveriesManage)
  updateZone(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto) {
    const { division, feeMinor, freeAboveMinor, bulkFeeMinor, ...rest } = dto;
    return this.delivery.updateZone(user, id, {
      ...rest,
      feeMinor: feeMinor !== undefined ? BigInt(feeMinor) : undefined,
      freeAboveMinor: freeAboveMinor !== undefined ? BigInt(freeAboveMinor) : undefined,
      bulkFeeMinor: bulkFeeMinor === undefined ? undefined : bulkFeeMinor === null ? null : BigInt(bulkFeeMinor),
    });
  }

  @Get('deliveries')
  @RequirePermissions(P.deliveriesManage)
  @ApiOperation({ summary: 'Delivery queue' })
  list(@CurrentUser() user: AuthUser, @Query() q: DeliveryListQueryDto) {
    return this.delivery.listDeliveries(user, q);
  }

  @Patch('deliveries/:id')
  @RequirePermissions(P.deliveriesManage)
  @ApiOperation({ summary: 'Assign, schedule, dispatch or complete a delivery' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeliveryDto) {
    return this.delivery.updateDelivery(user, id, dto);
  }
}
