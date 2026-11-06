import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { FulfilmentType } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { CartService } from './cart.service';

class AddCartItemDto {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty({ minimum: 1, maximum: 1000, example: 2 }) @IsInt() @Min(1) @Max(1000) quantity: number;
}

class SetQuantityDto {
  @ApiProperty({ minimum: 0, maximum: 1000, description: '0 removes the item' }) @IsInt() @Min(0) @Max(1000) quantity: number;
}

class QuoteQueryDto {
  @ApiProperty({ enum: FulfilmentType }) @IsEnum(FulfilmentType) fulfilmentType: FulfilmentType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
}

@ApiTags('Cart')
@Authenticated()
@Controller('carts')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get(':division')
  @ApiOperation({ summary: 'My cart for a division, priced on the server' })
  view(@CurrentUser() user: AuthUser, @Param('division') division: string) {
    return this.cart.view(user, division);
  }

  @Get(':division/quote')
  @ApiOperation({ summary: 'Checkout preview: items, delivery charge and total' })
  quote(@CurrentUser() user: AuthUser, @Param('division') division: string, @Query() q: QuoteQueryDto) {
    return this.cart.quote(user, division, q.fulfilmentType, q.addressId);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a variant to the cart (cart is chosen by the product’s division)' })
  add(@CurrentUser() user: AuthUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user, dto.variantId, dto.quantity);
  }

  @Patch('items/:variantId')
  @ApiOperation({ summary: 'Set the quantity of a cart line' })
  set(@CurrentUser() user: AuthUser, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() dto: SetQuantityDto) {
    return this.cart.setQuantity(user, variantId, dto.quantity);
  }

  @Delete('items/:variantId')
  @ApiOperation({ summary: 'Remove a cart line' })
  remove(@CurrentUser() user: AuthUser, @Param('variantId', ParseUUIDPipe) variantId: string) {
    return this.cart.removeItem(user, variantId);
  }

  @Delete(':division')
  @ApiOperation({ summary: 'Empty my cart for a division' })
  clear(@CurrentUser() user: AuthUser, @Param('division') division: string) {
    return this.cart.clear(user, division);
  }
}
