import { HttpCode, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import {
  AdminProductQueryDto,
  CreateCategoryDto,
  CreateProductDto,
  BulkProductsDto,
  ImageInputDto,
  PharmacyReviewDto,
  ProductQueryDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './catalog.dto';
import { CatalogService } from './catalog.service';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

class ShopDisplayDto {
  @ApiProperty() @IsBoolean() hideOutOfStock: boolean;
}

@ApiTags('Catalogue')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get('categories')
  @ApiQuery({ name: 'division', example: 'water-drinks-wines' })
  @ApiOperation({ summary: 'Product categories for a division' })
  categories(@Query('division') division: string) {
    return this.catalog.listCategories(division ?? 'water-drinks-wines');
  }

  @Public()
  @Get('products')
  @ApiOperation({ summary: 'List active products with variants, server prices and stock availability' })
  products(@Query() q: ProductQueryDto) {
    return this.catalog.listProducts(q);
  }

  @Public()
  @Get('products/:slug')
  @ApiOperation({ summary: 'Product details by slug or id' })
  product(@Param('slug') slug: string) {
    return this.catalog.getProduct(slug);
  }

  @Public()
  @Get('availability')
  @ApiQuery({ name: 'variantIds', description: 'Comma-separated variant ids (max 50)' })
  @ApiOperation({ summary: 'Live stock availability for variants' })
  availability(@Query('variantIds') ids: string) {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    return this.catalog.variantAvailability(list);
  }
}

@ApiTags('Admin · Catalogue')
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Patch('divisions/:division/display')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: "Hide or show this shop's out-of-stock items to customers" })
  setDisplay(@CurrentUser() user: AuthUser, @Param('division') division: string, @Body() dto: ShopDisplayDto) {
    return this.catalog.setHideOutOfStock(user, division, dto.hideOutOfStock);
  }

  @Get('products')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'List products in any status (scoped to divisions you manage)' })
  list(@CurrentUser() user: AuthUser, @Query() q: AdminProductQueryDto) {
    return this.catalog.adminListProducts(user, q);
  }

  @Get('products/:id')
  @RequirePermissions(P.catalogManage)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.adminGetProduct(user, id);
  }

  @Post('products')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Create a product (optionally with variants and images)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.catalog.createProduct(user, dto);
  }

  @Patch('products/:id')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Update product details or status (DRAFT / ACTIVE / ARCHIVED)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.catalog.updateProduct(user, id, dto);
  }

  @Post('products/:id/variants')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Add a variant (size / pack) with its price in kobo' })
  addVariant(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VariantInputDto) {
    return this.catalog.addVariant(user, id, dto);
  }

  @Post('products/bulk')
  @HttpCode(200)
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'One action on many products. Each is checked on its own, and any skipped are reported back' })
  bulk(@CurrentUser() user: AuthUser, @Body() dto: BulkProductsDto) {
    return this.catalog.bulk(user, dto);
  }

  @Post('products/:id/pharmacy-review')
  @HttpCode(200)
  @RequirePermissions(P.pharmacyApprove)
  @ApiOperation({ summary: 'Pharmacist decision: prescription status, approved details and whether it may be bought' })
  pharmacyReview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PharmacyReviewDto) {
    return this.catalog.pharmacyReview(user, id, dto);
  }

  @Patch('variants/:variantId')
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Update a variant (price changes are audited)' })
  updateVariant(@CurrentUser() user: AuthUser, @Param('variantId', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.catalog.updateVariant(user, id, dto);
  }

  @Post('products/:id/images')
  @RequirePermissions(P.catalogManage)
  addImage(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImageInputDto) {
    return this.catalog.addImage(user, id, dto);
  }

  @Delete('images/:imageId')
  @RequirePermissions(P.catalogManage)
  removeImage(@CurrentUser() user: AuthUser, @Param('imageId', ParseUUIDPipe) id: string) {
    return this.catalog.removeImage(user, id);
  }

  @Post('categories')
  @RequirePermissions(P.catalogManage)
  createCategory(@CurrentUser() user: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.catalog.createCategory(user, dto);
  }

  @Patch('categories/:id')
  @RequirePermissions(P.catalogManage)
  updateCategory(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.catalog.updateCategory(user, id, dto);
  }
}
