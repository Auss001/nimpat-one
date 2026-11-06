import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  providers: [MailService, NotificationsService],
  controllers: [NotificationsController],
  exports: [MailService, NotificationsService],
})
export class NotificationsModule {}
