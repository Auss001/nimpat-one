import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { Response } from 'express';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { FulfilmentType, OrderStatus, PayableState, PaymentOption } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min, ValidateNested } from 'class-validator';
import { Authenticated, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { MinorAmount } from '../catalog/catalog.dto';
import { OrdersService } from './orders.service';

class ChangeOrderAddressDto {
  @ApiProperty({ description: 'One of your saved addresses' }) @IsUUID() addressId: string;
}

class CheckoutDto {
  @ApiProperty({ example: 'water-drinks-wines', description: 'Division whose cart is checked out' }) @IsString() division: string;
  @ApiProperty({ enum: FulfilmentType }) @IsEnum(FulfilmentType) fulfilmentType: FulfilmentType;
  @ApiPropertyOptional({ description: 'Required for DELIVERY' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) customerNote?: string;
  @ApiPropertyOptional({ enum: PaymentOption, default: PaymentOption.PAYSTACK, description: 'How the customer will pay; must be one of the options returned by GET /orders/checkout-options' })
  @IsOptional() @IsEnum(PaymentOption) paymentOption?: PaymentOption;
  @ApiPropertyOptional({ description: 'Total (kobo) the customer saw; checkout fails with 409 if the server total differs' })
  @IsOptional() @MinorAmount() @IsInt() @Min(0) expectedTotalMinor?: number;
}

class OrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
}

class CheckoutOptionsQueryDto {
  @ApiProperty({ example: 'water-drinks-wines' }) @IsString() division: string;
  @ApiProperty({ enum: FulfilmentType }) @IsEnum(FulfilmentType) fulfilmentType: FulfilmentType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
}

class AdminOrderQueryDto extends OrderQueryDto {
  @ApiPropertyOptional({ enum: PayableState }) @IsOptional() @IsEnum(PayableState) paymentStatus?: PayableState;
  @ApiPropertyOptional({ enum: PaymentOption }) @IsOptional() @IsEnum(PaymentOption) paymentOption?: PaymentOption;
  @ApiPropertyOptional({ description: 'Order number or customer email' }) @IsOptional() @IsString() q?: string;
}

class OrderFilterDto {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional({ enum: PayableState }) @IsOptional() @IsEnum(PayableState) paymentStatus?: PayableState;
  @ApiPropertyOptional({ enum: PaymentOption }) @IsOptional() @IsEnum(PaymentOption) paymentOption?: PaymentOption;
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
}

class BulkOrdersDto {
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids?: string[];
  @ApiPropertyOptional({ description: 'Or: every order matching this filter (up to 1,000)' }) @IsOptional() @IsBoolean() allMatching?: boolean;
  @ApiPropertyOptional({ type: OrderFilterDto }) @IsOptional() @ValidateNested() @Type(() => OrderFilterDto) filter?: OrderFilterDto;
}

class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus }) @IsEnum(OrderStatus) status: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}

@ApiTags('Orders')
@Authenticated()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Prevents duplicate orders on retries' })
  @ApiOperation({ summary: 'Check out my cart: prices, delivery and stock are computed and reserved on the server' })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto, @IdempotencyKey() key?: string) {
    return this.orders.checkout(user, dto, key);
  }

  @Get('checkout-options')
  @ApiOperation({ summary: 'Payment options available for my cart (Paystack, bank transfer, pay on delivery, pay at pickup) and why any are unavailable' })
  checkoutOptions(@CurrentUser() user: AuthUser, @Query() q: CheckoutOptionsQueryDto) {
    return this.orders.checkoutOptions(user, q.division, q.fulfilmentType, q.addressId);
  }

  @Get()
  @ApiOperation({ summary: 'My order history' })
  list(@CurrentUser() user: AuthUser, @Query() q: OrderQueryDto) {
    return this.orders.listForCustomer(user, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'My order with status timeline, delivery and payments' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getForCustomer(user, id);
  }

  @Patch(':id/address')
  @ApiOperation({ summary: 'Deliver an unpaid order to another of your addresses, before it is sent out (the fee is worked out again)' })
  changeAddress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeOrderAddressDto) {
    return this.orders.changeDeliveryAddress(user, id, dto.addressId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unpaid order (releases reserved stock)' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancelByCustomer(user, id);
  }
}

@ApiTags('Admin · Orders')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions(P.ordersRead)
  @ApiOperation({ summary: 'Orders for divisions you can access' })
  list(@CurrentUser() user: AuthUser, @Query() q: AdminOrderQueryDto) {
    return this.orders.adminList(user, q);
  }

  @Get('export')
  @RequirePermissions(P.ordersRead)
  @ApiOperation({ summary: 'Download the orders matching the filters as a spreadsheet (.csv)' })
  export(@CurrentUser() user: AuthUser, @Query() q: OrderFilterDto, @Res() res: Response) {
    return this.orders.adminExportCsv(user, q, res);
  }

  @Post('bulk-delete')
  @HttpCode(200)
  @RequirePermissions(P.ordersManage)
  @ApiOperation({ summary: 'Delete many unpaid orders. Paid or under-way orders are skipped and kept.' })
  bulkDelete(@CurrentUser() user: AuthUser, @Body() dto: BulkOrdersDto) {
    return this.orders.adminBulkDelete(user, dto);
  }

  @Get(':id')
  @RequirePermissions(P.ordersRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.adminGet(user, id);
  }

  @Patch(':id/status')
  @RequirePermissions(P.ordersManage)
  @ApiOperation({ summary: 'Advance or cancel an order (fulfilment only — payment status is changed only by verified payments)' })
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.orders.adminUpdateStatus(user, id, dto.status, dto.note);
  }
}
