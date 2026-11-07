import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { HomeSlideKind, Prisma } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { MAX_PHOTO_BYTES, PHOTO_URL_PREFIX, PhotoStorageService } from '../photos/photo-storage.service';
import { PhotosModule } from '../photos/photos.module';

const TONES = ['sky', 'rose', 'gold', 'mint', 'violet'] as const;
const MAX_SHOWN = 12;

class UpdateHomeSlideDto {
  @ApiPropertyOptional({ enum: HomeSlideKind }) @IsOptional() @IsEnum(HomeSlideKind) kind?: HomeSlideKind;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @Length(1, 70) title?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @Length(1, 70) subtitle?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @Length(1, 24) buttonText?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'From the upload endpoint' }) @IsOptional() @IsString() @Matches(/^\/media\/[\w./-]+$/) imageUrl?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'A page in the app such as /spa, or an https link' })
  @IsOptional()
  @IsString()
  @Matches(/^(\/(?!\/)\S*|https:\/\/\S+)$/, { message: 'The link must be a page in the app (starting with /) or an https address' })
  linkTo?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() productId?: string | null;
  @ApiPropertyOptional({ enum: TONES }) @IsOptional() @IsIn(TONES) tone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString() startsAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString() endsAt?: string | null;
}

class CreateHomeSlideDto extends UpdateHomeSlideDto {
  @ApiProperty({ enum: HomeSlideKind }) @IsEnum(HomeSlideKind) declare kind: HomeSlideKind;
}

class SlideOrderDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) ids: string[];
}

@Injectable()
export class HomeSlidesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly storage: PhotoStorageService,
    private readonly audit: AuditService,
  ) {}

  /** What customers see now. A product slide drops out by itself if the product stops being on sale. */
  async listPublic() {
    const now = new Date();
    const slides = await this.prisma.homeSlide.findMany({
      where: {
        isActive: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: MAX_SHOWN,
    });
    const shown = await Promise.all(
      slides.map(async (s) => {
        const base = { id: s.id, kind: s.kind, title: s.title, subtitle: s.subtitle, buttonText: s.buttonText, imageUrl: s.imageUrl, linkTo: s.linkTo, tone: s.tone };
        if (s.kind !== HomeSlideKind.PRODUCT) return base;
        const p: any = s.productId ? await this.catalog.getProduct(s.productId).catch(() => null) : null;
        if (!p || !p.images?.length || p.priceFromMinor == null) return null;
        return { ...base, product: { name: p.name, slug: p.slug, priceFromMinor: p.priceFromMinor, image: p.images[0].url, isAgeRestricted: p.isAgeRestricted } };
      }),
    );
    return shown.filter(Boolean);
  }

  listAdmin() {
    return this.prisma.homeSlide.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { product: { select: { name: true, slug: true, status: true, images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } } } } },
    });
  }

  private async check(s: { kind: HomeSlideKind; imageUrl?: string | null; productId?: string | null; startsAt?: string | Date | null; endsAt?: string | Date | null }) {
    if (s.kind === HomeSlideKind.PICTURE && !s.imageUrl) throw new BadRequestException('Please add a picture for this slide');
    if (s.kind === HomeSlideKind.PRODUCT) {
      if (!s.productId) throw new BadRequestException('Please choose a product for this slide');
      if (!(await this.prisma.product.findUnique({ where: { id: s.productId }, select: { id: true } }))) throw new BadRequestException('That product no longer exists');
    }
    if (s.startsAt && s.endsAt && new Date(s.endsAt) <= new Date(s.startsAt)) throw new BadRequestException('The end date must be after the start date');
  }

  private fields(dto: UpdateHomeSlideDto): Prisma.HomeSlideUncheckedUpdateInput {
    return {
      kind: dto.kind,
      title: dto.title,
      subtitle: dto.subtitle,
      buttonText: dto.buttonText,
      imageUrl: dto.imageUrl,
      linkTo: dto.linkTo,
      productId: dto.productId,
      tone: dto.tone,
      isActive: dto.isActive,
      startsAt: dto.startsAt === null ? null : dto.startsAt ? new Date(dto.startsAt) : undefined,
      endsAt: dto.endsAt === null ? null : dto.endsAt ? new Date(dto.endsAt) : undefined,
    };
  }

  async create(user: AuthUser, dto: CreateHomeSlideDto) {
    await this.check(dto);
    const last = await this.prisma.homeSlide.aggregate({ _max: { sortOrder: true } });
    const slide = await this.prisma.homeSlide.create({
      data: { ...(this.fields(dto) as Prisma.HomeSlideUncheckedCreateInput), kind: dto.kind, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
    await this.audit.record({ actorId: user.id, action: 'home_slide.create', entityType: 'home_slide', entityId: slide.id });
    return slide;
  }

  private async find(id: string) {
    const slide = await this.prisma.homeSlide.findUnique({ where: { id } });
    if (!slide) throw new NotFoundException('Slide not found');
    return slide;
  }

  async update(user: AuthUser, id: string, dto: UpdateHomeSlideDto) {
    const before = await this.find(id);
    const merged = (key: 'imageUrl' | 'productId' | 'startsAt' | 'endsAt') => (dto[key] === undefined ? before[key] : dto[key]);
    await this.check({ kind: dto.kind ?? before.kind, imageUrl: merged('imageUrl') as string | null, productId: merged('productId') as string | null, startsAt: merged('startsAt'), endsAt: merged('endsAt') });
    const slide = await this.prisma.homeSlide.update({ where: { id }, data: this.fields(dto) });
    if (before.imageUrl && before.imageUrl !== slide.imageUrl) await this.discard(before.imageUrl);
    await this.audit.record({ actorId: user.id, action: 'home_slide.update', entityType: 'home_slide', entityId: id });
    return slide;
  }

  async remove(user: AuthUser, id: string) {
    const before = await this.find(id);
    await this.prisma.homeSlide.delete({ where: { id } });
    if (before.imageUrl) await this.discard(before.imageUrl);
    await this.audit.record({ actorId: user.id, action: 'home_slide.delete', entityType: 'home_slide', entityId: id });
    return { ok: true };
  }

  async reorder(user: AuthUser, ids: string[]) {
    await this.prisma.$transaction(ids.map((id, sortOrder) => this.prisma.homeSlide.updateMany({ where: { id }, data: { sortOrder } })));
    await this.audit.record({ actorId: user.id, action: 'home_slide.reorder', entityType: 'home_slide', entityId: ids[0] ?? 'none' });
    return this.listAdmin();
  }

  async upload(file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('Please choose a picture');
    return this.storage.save(file.buffer, 'banner');
  }

  /** Only uploaded files are removed, and only when no other slide still uses them. */
  private async discard(url: string) {
    if (!url.startsWith(PHOTO_URL_PREFIX)) return;
    if (await this.prisma.homeSlide.count({ where: { imageUrl: url } })) return;
    await this.storage.remove(url);
  }
}

@ApiTags('Home page')
@Controller('home-slides')
export class HomeSlidesController {
  constructor(private readonly slides: HomeSlidesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'The promos and featured items showing on the home page now' })
  list() {
    return this.slides.listPublic();
  }
}

// Changes the front page for every business, so it is limited to head-office administrators.
@ApiTags('Admin · Home page')
@Controller('admin/home-slides')
export class AdminHomeSlidesController {
  constructor(private readonly slides: HomeSlidesService) {}

  @Get()
  @RequirePermissions(P.divisionsManage)
  @ApiOperation({ summary: 'Every slide, including hidden and scheduled ones' })
  list() {
    return this.slides.listAdmin();
  }

  @Post()
  @RequirePermissions(P.divisionsManage)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateHomeSlideDto) {
    return this.slides.create(user, dto);
  }

  @Post('upload')
  @HttpCode(201)
  @RequirePermissions(P.divisionsManage)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Upload a slide picture. It is checked and stripped of hidden data, and never cropped' })
  upload(@UploadedFile() file?: { buffer: Buffer }) {
    return this.slides.upload(file);
  }

  @Put('order')
  @RequirePermissions(P.divisionsManage)
  reorder(@CurrentUser() user: AuthUser, @Body() dto: SlideOrderDto) {
    return this.slides.reorder(user, dto.ids);
  }

  @Patch(':id')
  @RequirePermissions(P.divisionsManage)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHomeSlideDto) {
    return this.slides.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(P.divisionsManage)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.slides.remove(user, id);
  }
}

@Module({
  imports: [CatalogModule, PhotosModule],
  providers: [HomeSlidesService],
  controllers: [HomeSlidesController, AdminHomeSlidesController],
})
export class HomeSlidesModule {}
