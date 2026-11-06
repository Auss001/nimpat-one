import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { InventoryService } from './inventory.service';

class InventoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Division id, slug or code' }) @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() locationId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() lowStockOnly?: boolean; // filters within the returned page
}

class AdjustStockDto {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty() @IsUUID() locationId: string;
  @ApiProperty({ description: 'Signed change to quantity on hand', example: 24 }) @IsInt() delta: number;
  @ApiProperty({ enum: ['RECEIPT', 'ADJUSTMENT', 'RETURN'] }) @IsIn(['RECEIPT', 'ADJUSTMENT', 'RETURN']) type: 'RECEIPT' | 'ADJUSTMENT' | 'RETURN';
  @ApiProperty({ example: 'Weekly delivery from plant' }) @IsString() @Length(3, 300) reason: string;
}

class CreateLocationDto {
  @ApiProperty({ description: 'Division id, slug or code' }) @IsString() division: string;
  @ApiProperty({ example: 'WDW-ABJ-01' }) @IsString() @Length(2, 40) code: string;
  @ApiProperty() @IsString() @Length(2, 120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateLevelDto {
  @ApiProperty() @IsInt() @Min(0) reorderLevel: number;
}

@ApiTags('Admin · Inventory')
@Controller('admin/inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(P.inventoryRead, P.inventoryManage)
  @ApiOperation({ summary: 'Stock levels (on hand, reserved, available, low-stock flag)' })
  async list(@CurrentUser() user: AuthUser, @Query() q: InventoryQueryDto) {
    const allowed = user.divisionFilter(P.inventoryRead);
    let divisionIds = allowed;
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.inventoryRead, d.id);
      divisionIds = [d.id];
    }
    const where: Prisma.StockLevelWhereInput = {
      locationId: q.locationId,
      location: { isActive: true, ...(divisionIds ? { divisionId: { in: divisionIds } } : {}) },
    };
    const { rows, total } = await this.inventory.listLevels(where, pageArgs(q).skip, pageArgs(q).take);
    return paginate(q.lowStockOnly ? rows.filter((r) => r.lowStock) : rows, total, q);
  }

  @Post('adjustments')
  @RequirePermissions(P.inventoryManage)
  @ApiOperation({ summary: 'Receive stock or correct quantity on hand (ledgered and audited)' })
  async adjust(@CurrentUser() user: AuthUser, @Body() dto: AdjustStockDto) {
    const location = await this.prisma.stockLocation.findUnique({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Stock location not found');
    user.assertCan(P.inventoryManage, location.divisionId);
    const result = await this.inventory.adjust({ ...dto, actorId: user.id });
    await this.audit.record({
      actorId: user.id,
      action: 'inventory.adjust',
      entityType: 'stock_level',
      entityId: result.id,
      divisionId: location.divisionId,
      changes: { ...dto },
    });
    return result;
  }

  @Patch('levels/:id')
  @RequirePermissions(P.inventoryManage)
  @ApiOperation({ summary: 'Set the reorder (low stock) threshold' })
  async updateLevel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLevelDto) {
    const level = await this.prisma.stockLevel.findUniqueOrThrow({ where: { id }, include: { location: true } });
    user.assertCan(P.inventoryManage, level.location.divisionId);
    return this.prisma.stockLevel.update({ where: { id }, data: { reorderLevel: dto.reorderLevel } });
  }

  @Get('movements')
  @RequirePermissions(P.inventoryRead, P.inventoryManage)
  @ApiOperation({ summary: 'Stock movement ledger for a variant' })
  async movements(@CurrentUser() user: AuthUser, @Query('variantId', ParseUUIDPipe) variantId: string, @Query() q: PaginationQueryDto) {
    const variant = await this.prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, include: { product: true } });
    user.assertCan(P.inventoryRead, variant.product.divisionId);
    const where = { variantId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  @Get('locations')
  @RequirePermissions(P.inventoryRead, P.inventoryManage)
  @ApiOperation({ summary: 'List stock locations' })
  locations(@CurrentUser() user: AuthUser) {
    const ids = user.divisionFilter(P.inventoryRead);
    return this.prisma.stockLocation.findMany({ where: ids ? { divisionId: { in: ids } } : {}, orderBy: { code: 'asc' } });
  }

  @Post('locations')
  @RequirePermissions(P.inventoryManage)
  @ApiOperation({ summary: 'Create a stock location (warehouse / depot)' })
  async createLocation(@CurrentUser() user: AuthUser, @Body() dto: CreateLocationDto) {
    const d = await this.divisions.resolve(dto.division);
    user.assertCan(P.inventoryManage, d.id);
    const { division, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.stockLocation.updateMany({ where: { divisionId: d.id, isDefault: true }, data: { isDefault: false } });
      const loc = await tx.stockLocation.create({ data: { ...data, divisionId: d.id } });
      await this.audit.record({ actorId: user.id, action: 'stock_location.create', entityType: 'stock_location', entityId: loc.id, divisionId: d.id }, tx);
      return loc;
    });
  }
}
