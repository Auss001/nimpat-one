import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Length } from 'class-validator';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { LoyaltyService } from './loyalty.service';

class AdjustPointsDto {
  @ApiProperty({ example: 500, description: 'Signed number of points' }) @IsInt() points: number;
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

@ApiTags('Green Wallet (Loyalty)')
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Authenticated()
  @Get('me')
  @ApiOperation({ summary: 'My Green Wallet points balance and history' })
  me(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.loyalty.summary(user.id, q);
  }

  @Public()
  @Get('rules')
  @ApiOperation({ summary: 'How points are earned in each division' })
  rules() {
    return this.loyalty.rules();
  }

  @Post('admin/users/:userId/adjustments')
  @RequirePermissions(P.loyaltyManage)
  @ApiOperation({ summary: 'Adjust a customer’s points (audited)' })
  adjust(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdjustPointsDto) {
    return this.loyalty.adjust(user.id, userId, dto.points, dto.reason);
  }
}

@Global()
@Module({ providers: [LoyaltyService], controllers: [LoyaltyController], exports: [LoyaltyService] })
export class LoyaltyModule {}
