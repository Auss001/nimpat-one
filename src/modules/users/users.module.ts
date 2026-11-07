import { Module } from '@nestjs/common';
import { AdminCustomersController, AdminCustomersService } from './admin-customers.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({ providers: [UsersService, AdminCustomersService], controllers: [UsersController, AdminCustomersController], exports: [UsersService] })
export class UsersModule {}
