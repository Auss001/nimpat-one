import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P, PermissionCode } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { MAX_PHOTO_BYTES, PhotoPreset, PhotoStorageService } from './photo-storage.service';

export const PHOTO_OWNERS = ['product', 'property', 'unit', 'vehicle', 'spa', 'service'] as const;
export type PhotoOwner = (typeof PHOTO_OWNERS)[number];
const MAX_PHOTOS = 20;

class UploadPhotoDto {
  @ApiPropertyOptional({ description: 'Photo to replace, keeping its position' }) @IsOptional() @IsUUID() replaceId?: string;
  @ApiPropertyOptional({ description: 'Size or pack this product photo shows' }) @IsOptional() @IsUUID() variantId?: string;
}

class UpdatePhotoDto {
  @ApiPropertyOptional({ description: 'Make this the first photo customers see' }) @IsOptional() @IsBoolean() main?: boolean;
  @ApiPropertyOptional({ description: 'Size or pack this product photo shows; null for the whole product', nullable: true })
  @IsOptional() @IsUUID() variantId?: string | null;
}

const OWNER = new ParseEnumPipe(Object.fromEntries(PHOTO_OWNERS.map((o) => [o, o])));

interface UploadedPhoto {
  buffer: Buffer;
  originalname: string;
}

export interface PhotoView {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  variantId?: string | null;
}

/** Owner of a set of photos: who may change them, how they are framed, and how they are stored. */
interface Gallery {
  divisionId: string;
  label: string;
  preset: PhotoPreset;
  permission: PermissionCode;
  /** True when the owner shows one photo, such as a spa treatment. */
  single: boolean;
  list(): Promise<PhotoView[]>;
  add(url: string, sortOrder: number, extra: { variantId?: string }): Promise<PhotoView>;
  remove(photoId: string): Promise<void>;
  setOrder(photoId: string, sortOrder: number): Promise<void>;
}

@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PhotoStorageService,
    private readonly audit: AuditService,
  ) {}

  private async gallery(owner: PhotoOwner, ownerId: string): Promise<Gallery> {
    const db = this.prisma;
    const missing = () => new NotFoundException('Record not found');
    switch (owner) {
      case 'product': {
        const product = await db.product.findUnique({ where: { id: ownerId } });
        if (!product) throw missing();
        return {
          divisionId: product.divisionId, label: product.name, preset: 'product', permission: P.catalogManage, single: false,
          list: () => db.productImage.findMany({ where: { productId: ownerId }, orderBy: { sortOrder: 'asc' } }),
          add: async (url, sortOrder, { variantId }) => {
            if (variantId && !(await db.productVariant.findFirst({ where: { id: variantId, productId: ownerId } }))) throw new BadRequestException('That size or pack does not belong to this product');
            return db.productImage.create({ data: { productId: ownerId, url, altText: product.name, sortOrder, variantId } });
          },
          remove: async (id) => void (await db.productImage.delete({ where: { id } })),
          setOrder: async (id, sortOrder) => void (await db.productImage.update({ where: { id }, data: { sortOrder } })),
        };
      }
      case 'property':
      case 'unit': {
        const isUnit = owner === 'unit';
        const unit = isUnit ? await db.apartmentUnit.findUnique({ where: { id: ownerId } }) : null;
        const property = await db.property.findUnique({ where: { id: unit?.propertyId ?? ownerId } });
        if (!property || (isUnit && !unit)) throw missing();
        const unitId = unit?.id ?? null;
        return {
          divisionId: property.divisionId, label: unit?.name ?? property.name, preset: 'scene', permission: P.listingsManage, single: false,
          list: () => db.propertyImage.findMany({ where: { propertyId: property.id, unitId }, orderBy: { sortOrder: 'asc' } }),
          add: (url, sortOrder) => db.propertyImage.create({ data: { propertyId: property.id, unitId, url, altText: unit?.name ?? property.name, sortOrder } }),
          remove: async (id) => void (await db.propertyImage.delete({ where: { id } })),
          setOrder: async (id, sortOrder) => void (await db.propertyImage.update({ where: { id }, data: { sortOrder } })),
        };
      }
      case 'vehicle': {
        const vehicle = await db.vehicle.findUnique({ where: { id: ownerId } });
        if (!vehicle) throw missing();
        const label = `${vehicle.make} ${vehicle.model}`;
        return {
          divisionId: vehicle.divisionId, label, preset: 'scene', permission: P.listingsManage, single: false,
          list: () => db.vehicleImage.findMany({ where: { vehicleId: ownerId }, orderBy: { sortOrder: 'asc' } }),
          add: (url, sortOrder) => db.vehicleImage.create({ data: { vehicleId: ownerId, url, altText: label, sortOrder } }),
          remove: async (id) => void (await db.vehicleImage.delete({ where: { id } })),
          setOrder: async (id, sortOrder) => void (await db.vehicleImage.update({ where: { id }, data: { sortOrder } })),
        };
      }
      case 'spa':
      case 'service': {
        const isSpa = owner === 'spa';
        const row = isSpa ? await db.spaTreatment.findUnique({ where: { id: ownerId } }) : await db.serviceOffering.findUnique({ where: { id: ownerId } });
        if (!row) throw missing();
        const save = (imageUrl: string | null) =>
          isSpa ? db.spaTreatment.update({ where: { id: ownerId }, data: { imageUrl } }) : db.serviceOffering.update({ where: { id: ownerId }, data: { imageUrl } });
        const view = (url: string): PhotoView => ({ id: ownerId, url, altText: row.name, sortOrder: 0 });
        return {
          divisionId: row.divisionId, label: row.name, preset: 'scene', permission: P.listingsManage, single: true,
          list: async () => {
            const current = isSpa ? await db.spaTreatment.findUnique({ where: { id: ownerId } }) : await db.serviceOffering.findUnique({ where: { id: ownerId } });
            return current?.imageUrl ? [view(current.imageUrl)] : [];
          },
          add: async (url) => {
            await save(url);
            return view(url);
          },
          remove: async () => void (await save(null)),
          setOrder: async () => undefined,
        };
      }
    }
  }

  private async authorised(user: AuthUser, owner: PhotoOwner, ownerId: string) {
    const gallery = await this.gallery(owner, ownerId);
    user.assertCan(gallery.permission, gallery.divisionId);
    return gallery;
  }

  /** Removes a file unless another record still shows it. */
  private async removeFileIfUnused(url: string) {
    const counts = await Promise.all([
      this.prisma.productImage.count({ where: { url } }),
      this.prisma.propertyImage.count({ where: { url } }),
      this.prisma.vehicleImage.count({ where: { url } }),
      this.prisma.spaTreatment.count({ where: { imageUrl: url } }),
      this.prisma.serviceOffering.count({ where: { imageUrl: url } }),
    ]);
    if (counts.every((n) => n === 0)) await this.storage.remove(url);
  }

  async list(user: AuthUser, owner: PhotoOwner, ownerId: string) {
    const gallery = await this.authorised(user, owner, ownerId);
    const variants = owner === 'product' ? await this.prisma.productVariant.findMany({ where: { productId: ownerId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, sku: true } }) : [];
    return { label: gallery.label, preset: gallery.preset, single: gallery.single, photos: await gallery.list(), variants };
  }

  private async record(user: AuthUser, gallery: Gallery, owner: PhotoOwner, ownerId: string, action: string, changes: Record<string, unknown>) {
    await this.audit.record({ actorId: user.id, action: `photo.${action}`, entityType: owner, entityId: ownerId, divisionId: gallery.divisionId, changes });
  }

  async upload(user: AuthUser, owner: PhotoOwner, ownerId: string, file: UploadedPhoto | undefined, dto: UploadPhotoDto) {
    const gallery = await this.authorised(user, owner, ownerId);
    if (!file) throw new BadRequestException('Choose a photo to upload');
    const existing = await gallery.list();
    const replaced = gallery.single ? existing[0] : dto.replaceId ? existing.find((p) => p.id === dto.replaceId) : undefined;
    if (dto.replaceId && !replaced) throw new NotFoundException('Photo not found');
    if (!replaced && existing.length >= MAX_PHOTOS) throw new BadRequestException(`A record can hold up to ${MAX_PHOTOS} photos. Remove one first.`);

    const { url, warning } = await this.storage.save(file.buffer, gallery.preset);
    try {
      const sortOrder = replaced ? replaced.sortOrder : existing.reduce((n, p) => Math.max(n, p.sortOrder + 1), 0);
      // For one-photo owners, saving the new address already replaces the old one.
      if (replaced && !gallery.single) await gallery.remove(replaced.id);
      const photo = await gallery.add(url, sortOrder, { variantId: dto.variantId ?? replaced?.variantId ?? undefined });
      if (replaced) await this.removeFileIfUnused(replaced.url);
      await this.record(user, gallery, owner, ownerId, replaced ? 'replace' : 'add', { url, replaced: replaced?.url });
      return { ...photo, warning };
    } catch (e) {
      await this.storage.remove(url);
      throw e;
    }
  }

  async update(user: AuthUser, owner: PhotoOwner, ownerId: string, photoId: string, dto: UpdatePhotoDto) {
    const gallery = await this.authorised(user, owner, ownerId);
    const photos = await gallery.list();
    const target = photos.find((p) => p.id === photoId);
    if (!target) throw new NotFoundException('Photo not found');
    if (dto.main) {
      const others = photos.filter((p) => p.id !== photoId);
      await gallery.setOrder(photoId, 0);
      for (const [i, p] of others.entries()) await gallery.setOrder(p.id, i + 1);
      await this.record(user, gallery, owner, ownerId, 'main', { url: target.url });
    }
    if (dto.variantId !== undefined) {
      if (owner !== 'product') throw new BadRequestException('Only product photos can belong to a size or pack');
      if (dto.variantId && !(await this.prisma.productVariant.findFirst({ where: { id: dto.variantId, productId: ownerId } }))) throw new BadRequestException('That size or pack does not belong to this product');
      await this.prisma.productImage.update({ where: { id: photoId }, data: { variantId: dto.variantId } });
      await this.record(user, gallery, owner, ownerId, 'variant', { url: target.url, variantId: dto.variantId });
    }
    return this.list(user, owner, ownerId);
  }

  async remove(user: AuthUser, owner: PhotoOwner, ownerId: string, photoId: string) {
    const gallery = await this.authorised(user, owner, ownerId);
    const target = (await gallery.list()).find((p) => p.id === photoId);
    if (!target) throw new NotFoundException('Photo not found');
    await gallery.remove(photoId);
    await this.removeFileIfUnused(target.url);
    await this.record(user, gallery, owner, ownerId, 'remove', { url: target.url });
    return { ok: true };
  }

  /**
   * Bulk upload: the file name decides where a photo goes. NMP-WTR-002.png
   * replaces that product's photos, and NMP-WTR-002-2.png adds an extra one.
   */
  async uploadBySku(user: AuthUser, fileName: string, file: UploadedPhoto | undefined) {
    if (!file) throw new BadRequestException('Choose a photo to upload');
    const base = fileName.replace(/\.[^.]+$/, '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,60}$/.test(base)) throw new BadRequestException('The file name must be the product SKU, for example NMP-WTR-002.png');
    const select = { id: true, sku: true, productId: true, product: { select: { name: true, divisionId: true, _count: { select: { variants: true } } } } };
    let variant = await this.prisma.productVariant.findUnique({ where: { sku: base }, select });
    let extra = false;
    if (!variant && /-\d{1,2}$/.test(base)) {
      variant = await this.prisma.productVariant.findUnique({ where: { sku: base.replace(/-\d{1,2}$/, '') }, select });
      extra = !!variant;
    }
    if (!variant) throw new NotFoundException(`No product has the SKU ${base}`);
    if (!user.can(P.catalogManage, variant.product.divisionId)) throw new ForbiddenException('You cannot change this product');

    // A product with several sizes keeps a photo per size; otherwise the photo is for the whole product.
    const variantId = variant.product._count.variants > 1 ? variant.id : undefined;
    const gallery = await this.gallery('product', variant.productId);
    const { url, warning } = await this.storage.save(file.buffer, 'product');
    try {
      const existing = await gallery.list();
      if (extra) {
        const photo = await gallery.add(url, existing.reduce((n, p) => Math.max(n, p.sortOrder + 1), 0), { variantId });
        await this.record(user, gallery, 'product', variant.productId, 'add', { url, sku: variant.sku, file: base });
        return { sku: variant.sku, product: variant.product.name, action: 'added', url: photo.url, warning };
      }
      const old = existing.filter((p) => (variantId ? p.variantId === variantId : true));
      for (const p of old) await gallery.remove(p.id);
      const first = existing.length === old.length ? 0 : existing.reduce((n, p) => Math.max(n, p.sortOrder + 1), 0);
      const photo = await gallery.add(url, first, { variantId });
      for (const p of old) await this.removeFileIfUnused(p.url);
      await this.record(user, gallery, 'product', variant.productId, old.length ? 'replace' : 'add', { url, sku: variant.sku, replaced: old.map((p) => p.url) });
      return { sku: variant.sku, product: variant.product.name, action: old.length ? 'replaced' : 'added', url: photo.url, warning };
    } catch (e) {
      await this.storage.remove(url);
      throw e;
    }
  }
}

const FILE_BODY = {
  schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, replaceId: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' } } },
};
const photoFile = () => FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });

@ApiTags('Admin · Photos')
@Controller('admin/photos')
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post('by-sku')
  @RequirePermissions(P.catalogManage)
  @UseInterceptors(photoFile())
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Bulk upload: the file name is the SKU. NMP-WTR-002.png replaces; NMP-WTR-002-2.png adds another photo' })
  bySku(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedPhoto) {
    return this.photos.uploadBySku(user, file?.originalname ?? '', file);
  }

  @Get(':owner/:ownerId')
  @RequirePermissions(P.catalogManage, P.listingsManage)
  @ApiOperation({ summary: 'Photos of a product, property, unit, vehicle, spa treatment or service' })
  list(@CurrentUser() user: AuthUser, @Param('owner', OWNER) owner: PhotoOwner, @Param('ownerId', ParseUUIDPipe) ownerId: string) {
    return this.photos.list(user, owner, ownerId);
  }

  @Post(':owner/:ownerId')
  @RequirePermissions(P.catalogManage, P.listingsManage)
  @UseInterceptors(photoFile())
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOperation({ summary: 'Upload a photo. It is checked, stripped of hidden data, and resized to the standard frame' })
  upload(@CurrentUser() user: AuthUser, @Param('owner', OWNER) owner: PhotoOwner, @Param('ownerId', ParseUUIDPipe) ownerId: string, @Body() dto: UploadPhotoDto, @UploadedFile() file?: UploadedPhoto) {
    return this.photos.upload(user, owner, ownerId, file, dto);
  }

  @Patch(':owner/:ownerId/:photoId')
  @RequirePermissions(P.catalogManage, P.listingsManage)
  @ApiOperation({ summary: 'Make a photo the main one, or link it to a size or pack' })
  update(@CurrentUser() user: AuthUser, @Param('owner', OWNER) owner: PhotoOwner, @Param('ownerId', ParseUUIDPipe) ownerId: string, @Param('photoId', ParseUUIDPipe) photoId: string, @Body() dto: UpdatePhotoDto) {
    return this.photos.update(user, owner, ownerId, photoId, dto);
  }

  @Delete(':owner/:ownerId/:photoId')
  @RequirePermissions(P.catalogManage, P.listingsManage)
  @ApiOperation({ summary: 'Remove a photo' })
  remove(@CurrentUser() user: AuthUser, @Param('owner', OWNER) owner: PhotoOwner, @Param('ownerId', ParseUUIDPipe) ownerId: string, @Param('photoId', ParseUUIDPipe) photoId: string) {
    return this.photos.remove(user, owner, ownerId, photoId);
  }
}

@Module({ providers: [PhotosService, PhotoStorageService], controllers: [PhotosController], exports: [PhotoStorageService] })
export class PhotosModule {}
