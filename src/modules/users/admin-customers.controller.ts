import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, UserType } from '@prisma/client';
import { IsOptional, IsString, Length } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';

class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Name, email or phone' }) @IsOptional() @IsString() @Length(1, 120) q?: string;
}

@Injectable()
export class AdminCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** A manager of one business sees only the customers of that business. */
  async list(user: AuthUser, q: CustomerQueryDto) {
    const scope = user.divisionFilter(P.customersRead);
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = {
      type: UserType.CUSTOMER,
      email: { not: { endsWith: '@deleted.invalid' } },
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
          _count: { select: { orders: true, reservations: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(rows, total, q);
  }
}

@ApiTags('Admin · Customers')
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  @RequirePermissions(P.customersRead)
  @ApiOperation({ summary: 'Search customers' })
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerQueryDto) {
    return this.customers.list(user, q);
  }
}
