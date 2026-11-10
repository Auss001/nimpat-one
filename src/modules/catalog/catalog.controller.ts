import { HttpCode, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PriceListService } from './price-list.service';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import {
  ApplyDetailsDto,
  ApplyPriceListDto,
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
  constructor(
    private readonly catalog: CatalogService,
    private readonly priceList: PriceListService,
  ) {}

  @Post('price-list/preview')
  @HttpCode(200)
  @RequirePermissions(P.catalogManage)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file', 'division'], properties: { file: { type: 'string', format: 'binary' }, division: { type: 'string' } } } })
  @ApiOperation({ summary: 'Read a price list (.xlsx or .csv) and show what would change. Nothing is saved' })
  previewPriceList(@CurrentUser() user: AuthUser, @Body('division') division: string, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    return this.priceList.preview(user, division, file);
  }

  @Post('details/preview')
  @HttpCode(200)
  @RequirePermissions(P.catalogManage)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Read a sheet of product names and descriptions (by SKU) and show what would change. Nothing is saved' })
  previewDetails(@CurrentUser() user: AuthUser, @Body('division') division: string, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    return this.priceList.detailsPreview(user, division, file);
  }

  @Post('details/apply')
  @HttpCode(200)
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Apply the ticked product names and descriptions' })
  applyDetails(@CurrentUser() user: AuthUser, @Body() dto: ApplyDetailsDto) {
    return this.priceList.detailsApply(user, dto);
  }

  @Post('price-list/apply')
  @HttpCode(200)
  @RequirePermissions(P.catalogManage)
  @ApiOperation({ summary: 'Apply the ticked rows of a previewed price list. Prices go live at once' })
  applyPriceList(@CurrentUser() user: AuthUser, @Body() dto: ApplyPriceListDto) {
    return this.priceList.apply(user, dto);
  }

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
