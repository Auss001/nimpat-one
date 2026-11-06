import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({ providers: [AdminUsersService], controllers: [AdminUsersController] })
export class AdminModule {}
