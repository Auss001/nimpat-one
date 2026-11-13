import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, UserType } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { Response } from 'express';
import { naira, sendCsv } from '../../common/utils/csv';
import { UsersService } from './users.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';

class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Name, email or phone' }) @IsOptional() @IsString() @Length(1, 120) q?: string;
  @ApiPropertyOptional({ enum: ['members', 'guests'], description: 'Royalty Members (account with a password) or guests (details only)' })
  @IsOptional() @IsIn(['members', 'guests']) kind?: 'members' | 'guests';
}

class CustomerFilterDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) q?: string;
  @ApiPropertyOptional({ enum: ['members', 'guests'] }) @IsOptional() @IsIn(['members', 'guests']) kind?: 'members' | 'guests';
}

class BulkCustomersDto {
  @ApiPropertyOptional({ type: [String], description: 'The customers picked in the list' })
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids?: string[];
  @ApiPropertyOptional({ description: 'Or: every customer matching this search (up to 1,000)' })
  @IsOptional() @IsBoolean() allMatching?: boolean;
  @ApiPropertyOptional({ type: CustomerFilterDto }) @IsOptional() @ValidateNested() @Type(() => CustomerFilterDto) filter?: CustomerFilterDto;
}

@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  /** A manager of one business sees only the customers of that business. */
  where(user: AuthUser, q: { q?: string; kind?: 'members' | 'guests' }): Prisma.UserWhereInput {
    const scope = user.divisionFilter(P.customersRead);
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = {
      type: UserType.CUSTOMER,
      email: { not: { endsWith: '@deleted.invalid' } },
      ...(q.kind ? { isGuest: q.kind === 'guests' } : {}),
      ...(scope ? { OR: [{ orders: { some: { divisionId: { in: scope } } } }, { reservations: { some: { unit: { property: { divisionId: { in: scope } } } } } }] } : {}),
      ...(term
        ? {
            AND: [
              {
                OR: [
                  { email: { contains: term, mode: 'insensitive' as const } },
                  { contactEmail: { contains: term, mode: 'insensitive' as const } },
                  { contactPhone: { contains: term } },
                  { phone: { contains: term } },
                  { customerProfile: { firstName: { contains: term, mode: 'insensitive' as const } } },
                  { customerProfile: { lastName: { contains: term, mode: 'insensitive' as const } } },
                ],
              },
            ],
          }
        : {}),
    };
    return where;
  }

  async list(user: AuthUser, q: CustomerQueryDto) {
    const where = this.where(user, q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        select: {
          id: true,
          email: true,
          isGuest: true,
          contactEmail: true,
          contactPhone: true,
          phone: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
          customerProfile: { select: { firstName: true, lastName: true } },
          loyaltyAccount: { select: { pointsBalance: true, lifetimeEarned: true, tier: true } },
          _count: { select: { orders: true, reservations: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    // How many Royalty Members there are in this view, whatever the filter.
    const members = await this.prisma.user.count({ where: { ...where, isGuest: false } });
    return { ...paginate(rows, total, q), members };
  }

  /** Every customer matching the search, as a spreadsheet. */
  async exportCsv(user: AuthUser, q: { q?: string; kind?: 'members' | 'guests' }, res: Response) {
    const rows = await this.prisma.user.findMany({
      where: this.where(user, q),
      orderBy: { createdAt: 'desc' },
      take: 20000,
      select: {
        email: true, isGuest: true, contactEmail: true, contactPhone: true, phone: true, status: true, emailVerifiedAt: true, createdAt: true,
        customerProfile: { select: { firstName: true, lastName: true } },
        loyaltyAccount: { select: { pointsBalance: true, tier: true } },
        _count: { select: { orders: true, reservations: true } },
        orders: { where: { amountPaidMinor: { gt: 0 } }, select: { amountPaidMinor: true } },
      },
    });
    sendCsv(res, 'nimpat-customers-' + new Date().toISOString().slice(0, 10) + '.csv',
      ['First name', 'Last name', 'Email', 'Phone', 'Type', 'Email confirmed', 'Status', 'Joined', 'Orders', 'Apartment bookings', 'Paid on orders (NGN)', 'Royalty points', 'Royalty tier'],
      rows.map((u) => [
        u.customerProfile?.firstName, u.customerProfile?.lastName, u.contactEmail ?? (u.isGuest ? '' : u.email), u.contactPhone ?? u.phone,
        u.isGuest ? 'Guest' : 'Royalty Member', u.emailVerifiedAt ? 'Yes' : 'No', u.status, u.createdAt,
        u._count.orders, u._count.reservations, naira(u.orders.reduce((t, o) => t + o.amountPaidMinor, 0n)),
        u.loyaltyAccount?.pointsBalance ?? 0, u.loyaltyAccount?.tier ?? '',
      ]));
  }

  /**
   * Deletes customers the way a customer deletes their own account: personal details erased, sign-in stopped, past
   * orders and payments kept without a name. Nothing paid is cancelled; unpaid orders and holds expire by themselves.
   */
  async bulkDelete(user: AuthUser, dto: BulkCustomersDto) {
    // Group-wide administrators only: a manager of one business cannot erase customers.
    user.assertCan(P.rolesAssign, null);
    let ids = dto.ids ?? [];
    if (dto.allMatching) {
      ids = (await this.prisma.user.findMany({ where: this.where(user, dto.filter ?? {}), select: { id: true }, take: 1000 })).map((u) => u.id);
    }
    if (!ids.length) throw new BadRequestException('Pick at least one customer');
    const found = await this.prisma.user.findMany({ where: { id: { in: ids }, type: UserType.CUSTOMER, email: { not: { endsWith: '@deleted.invalid' } } }, select: { id: true } });
    let deleted = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const { id } of found) {
      try {
        await this.users.erase(id, user.id);
        deleted++;
      } catch (e) {
        skipped.push({ id, reason: (e as Error).message });
      }
    }
    return { deleted, skipped, notFound: ids.length - found.length };
  }
}

@ApiTags('Admin · Customers')
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get('export')
  @RequirePermissions(P.customersRead)
  @ApiOperation({ summary: 'Download the customers matching the search as a spreadsheet (.csv)' })
  export(@CurrentUser() user: AuthUser, @Query() q: CustomerFilterDto, @Res() res: Response) {
    return this.customers.exportCsv(user, q, res);
  }

  @Post('bulk-delete')
  @HttpCode(200)
  @RequirePermissions(P.rolesAssign)
  @ApiOperation({ summary: 'Delete many customers (administrators only). Personal details are erased; financial records stay without a name.' })
  bulkDelete(@CurrentUser() user: AuthUser, @Body() dto: BulkCustomersDto) {
    return this.customers.bulkDelete(user, dto);
  }

  @Get()
  @RequirePermissions(P.customersRead)
  @ApiOperation({ summary: 'Search customers' })
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerQueryDto) {
    return this.customers.list(user, q);
  }
}
