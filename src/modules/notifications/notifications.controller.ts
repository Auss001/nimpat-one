import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

class PushDeviceDto {
  @ApiProperty({ description: 'Firebase Cloud Messaging token from the phone app' }) @IsString() @Length(20, 4096) token: string;
  @ApiProperty({ enum: ['android', 'ios'] }) @IsIn(['android', 'ios']) platform: 'android' | 'ios';
}
class RemovePushDeviceDto {
  @ApiProperty() @IsString() @Length(20, 4096) token: string;
}

class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  unreadOnly?: boolean;
}

@ApiTags('Notifications')
@Authenticated()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Post('devices')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive notifications on this phone' })
  addDevice(@CurrentUser() user: AuthUser, @Body() dto: PushDeviceDto) {
    return this.push.register(user.id, dto.token, dto.platform);
  }

  @Post('devices/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop notifications on this phone (on sign-out)' })
  removeDevice(@CurrentUser() user: AuthUser, @Body() dto: RemovePushDeviceDto) {
    return this.push.unregister(user.id, dto.token);
  }

  @Get()
  @ApiOperation({ summary: 'List my in-app notifications' })
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationQueryDto) {
    return this.notifications.listForUser(user.id, q);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a notification as read' })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }
}
