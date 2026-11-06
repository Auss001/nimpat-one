import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKU = /^[A-Z0-9][A-Z0-9-]{1,47}$/;

/** Minor-unit money input: integer kobo, accepts number or numeric string. */
export const MinorAmount = () => Transform(({ value }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value));

export class ProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Division id, slug or code', example: 'water-drinks-wines' })
  @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional({ description: 'Category slug' }) @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional({ description: 'Free-text search' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional({ enum: ['name', 'newest', 'price_asc', 'price_desc'] })
  @IsOptional() @IsString() sort?: 'name' | 'newest' | 'price_asc' | 'price_desc';
}

export class AdminProductQueryDto extends ProductQueryDto {
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
}

export class CreateCategoryDto {
  @ApiProperty({ description: 'Division id, slug or code' }) @IsString() division: string;
  @ApiProperty({ example: 'Table Water' }) @IsString() @Length(2, 80) name: string;
  @ApiProperty({ example: 'table-water' }) @Matches(SLUG) @Length(2, 80) slug: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

export class VariantInputDto {
  @ApiProperty({ example: 'WDW-TW-75CL-12' }) @Matches(SKU, { message: 'sku must be upper-case letters, digits and dashes' }) sku: string;
  @ApiProperty({ example: 'Pack of 12 x 75cl' }) @IsString() @Length(1, 120) name: string;
  @ApiProperty({ description: 'Price in kobo (integer)', example: 250000 })
  @MinorAmount() @IsInt() @Min(0) @Max(1_000_000_000_00) unitPriceMinor: number;
  @ApiPropertyOptional({ description: 'Original price in kobo for strike-through display' })
  @IsOptional() @MinorAmount() @IsInt() @Min(0) compareAtPriceMinor?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) unitsPerPack?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) minOrderQty?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxOrderQty?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateVariantDto extends PartialType(VariantInputDto) {}

/** An https URL, or a path to a photo served by this API under /media/. */
export const IMAGE_URL = /^(https:\/\/[^\s]+|\/media\/[A-Za-z0-9._\/-]+)$/;

export class ImageInputDto {
  @ApiProperty({ example: '/media/assets/drinks-stock-1.jpg' })
  @Matches(IMAGE_URL, { message: 'url must be an https URL or a /media/ path' })
  url: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 200) altText?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class CreateProductDto {
  @ApiProperty({ description: 'Division id, slug or code' }) @IsString() division: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty() @IsString() @Length(2, 160) name: string;
  @ApiProperty() @Matches(SLUG) @Length(2, 160) slug: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) brand?: string;
  @ApiPropertyOptional({ enum: ProductStatus, default: ProductStatus.DRAFT }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isDeliverable?: boolean;
  @ApiPropertyOptional({ default: false, description: 'Alcoholic products (18+)' }) @IsOptional() @IsBoolean() isAgeRestricted?: boolean;

  @ApiPropertyOptional({ type: [VariantInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => VariantInputDto)
  variants?: VariantInputDto[];

  @ApiPropertyOptional({ type: [ImageInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ImageInputDto)
  images?: ImageInputDto[];
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 160) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(SLUG) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) brand?: string;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDeliverable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAgeRestricted?: boolean;
}
