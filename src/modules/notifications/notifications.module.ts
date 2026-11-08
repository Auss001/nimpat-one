import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

@Global()
@Module({
  providers: [MailService, NotificationsService, PushService],
  controllers: [NotificationsController],
  exports: [MailService, NotificationsService, PushService],
})
export class NotificationsModule {}
