import { Global, Module } from '@nestjs/common';
import { DivisionsController } from './divisions.controller';
import { DivisionsService } from './divisions.service';

@Global()
@Module({ providers: [DivisionsService], controllers: [DivisionsController], exports: [DivisionsService] })
export class DivisionsModule {}
