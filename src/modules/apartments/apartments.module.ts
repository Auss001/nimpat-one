import { Module } from '@nestjs/common';
import { AdminApartmentsController, ApartmentsController } from './apartments.controller';
import { ApartmentsService } from './apartments.service';

@Module({ providers: [ApartmentsService], controllers: [ApartmentsController, AdminApartmentsController], exports: [ApartmentsService] })
export class ApartmentsModule {}
