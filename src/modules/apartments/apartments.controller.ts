import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import {
  AdminReservationQueryDto,
  CalendarQueryDto,
  CancelReservationDto,
  CreateBlackoutDto,
  CreatePropertyDto,
  CreateReservationDto,
  CreateRoomDto,
  CreateUnitDto,
  PropertyQueryDto,
  ReservationQueryDto,
  StayQueryDto,
  UpdatePropertyDto,
  UpdateReservationStatusDto,
  UpdateRoomDto,
  UpdateUnitDto,
} from './apartments.dto';
import { ApartmentsService } from './apartments.service';

@ApiTags('Luxury Apartments')
@Controller('apartments')
export class ApartmentsController {
  constructor(private readonly apartments: ApartmentsService) {}

  @Public()
  @Get('properties')
  @ApiOperation({ summary: 'Search properties; pass checkIn/checkOut to see availability' })
  properties(@Query() q: PropertyQueryDto) {
    return this.apartments.listProperties(q);
  }

  @Public()
  @Get('properties/:slug')
  @ApiOperation({ summary: 'Property with its bookable units' })
  property(@Param('slug') slug: string) {
    return this.apartments.getProperty(slug);
  }

  @Public()
  @Get('units/:unitId/calendar')
  @ApiOperation({ summary: 'Unavailable date ranges for a unit ([start, end) — end is the checkout day)' })
  calendar(@Param('unitId', ParseUUIDPipe) unitId: string, @Query() q: CalendarQueryDto) {
    return this.apartments.calendar(unitId, q.from, q.to, q.roomId);
  }

  @Public()
  @Get('units/:unitId/quote')
  @ApiOperation({ summary: 'Price breakdown (nightly × nights + cleaning + caution deposit) and availability, for the whole unit or one room' })
  quote(@Param('unitId', ParseUUIDPipe) unitId: string, @Query() q: StayQueryDto) {
    return this.apartments.quote(unitId, q.checkIn, q.checkOut, q.guests, q.roomId);
  }

  @Authenticated()
  @Post('reservations')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Hold dates for 15 minutes pending payment (purpose APARTMENT_RESERVATION)' })
  reserve(@CurrentUser() user: AuthUser, @Body() dto: CreateReservationDto, @IdempotencyKey() key?: string) {
    return this.apartments.createReservation(user, dto, key);
  }

  @Authenticated()
  @Get('reservations')
  @ApiOperation({ summary: 'My reservations' })
  mine(@CurrentUser() user: AuthUser, @Query() q: ReservationQueryDto) {
    return this.apartments.listForCustomer(user, q);
  }

  @Authenticated()
  @Get('reservations/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.apartments.getForCustomer(user, id);
  }

  @Authenticated()
  @Post('reservations/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unpaid hold' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelReservationDto) {
    return this.apartments.cancelByCustomer(user, id, dto.reason);
  }
}

@ApiTags('Admin · Luxury Apartments')
@Controller('admin/apartments')
export class AdminApartmentsController {
  constructor(private readonly apartments: ApartmentsService) {}

  @Get('properties')
  @RequirePermissions(P.listingsManage)
  properties(@CurrentUser() user: AuthUser) {
    return this.apartments.adminListProperties(user);
  }

  @Post('properties')
  @RequirePermissions(P.listingsManage)
  createProperty(@CurrentUser() user: AuthUser, @Body() dto: CreatePropertyDto) {
    return this.apartments.createProperty(user, dto);
  }

  @Patch('properties/:id')
  @RequirePermissions(P.listingsManage)
  updateProperty(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePropertyDto) {
    return this.apartments.updateProperty(user, id, dto);
  }

  @Post('properties/:id/units')
  @RequirePermissions(P.listingsManage)
  createUnit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateUnitDto) {
    return this.apartments.createUnit(user, id, dto);
  }

  @Patch('units/:unitId')
  @RequirePermissions(P.listingsManage)
  updateUnit(@CurrentUser() user: AuthUser, @Param('unitId', ParseUUIDPipe) id: string, @Body() dto: UpdateUnitDto) {
    return this.apartments.updateUnit(user, id, dto);
  }

  @Post('units/:unitId/rooms')
  @RequirePermissions(P.listingsManage)
  @ApiOperation({ summary: 'Make a room bookable on its own' })
  createRoom(@CurrentUser() user: AuthUser, @Param('unitId', ParseUUIDPipe) id: string, @Body() dto: CreateRoomDto) {
    return this.apartments.createRoom(user, id, dto);
  }

  @Patch('rooms/:roomId')
  @RequirePermissions(P.listingsManage)
  updateRoom(@CurrentUser() user: AuthUser, @Param('roomId', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) {
    return this.apartments.updateRoom(user, id, dto);
  }

  @Post('units/:unitId/blackouts')
  @RequirePermissions(P.listingsManage)
  @ApiOperation({ summary: 'Block dates for maintenance or owner use' })
  blackout(@CurrentUser() user: AuthUser, @Param('unitId', ParseUUIDPipe) id: string, @Body() dto: CreateBlackoutDto) {
    return this.apartments.addBlackout(user, id, dto);
  }

  @Get('reservations')
  @RequirePermissions(P.bookingsRead)
  reservations(@CurrentUser() user: AuthUser, @Query() q: AdminReservationQueryDto) {
    return this.apartments.adminListReservations(user, q);
  }

  @Patch('reservations/:id/status')
  @RequirePermissions(P.bookingsManage)
  @ApiOperation({ summary: 'Check in, complete or cancel a reservation' })
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservationStatusDto) {
    return this.apartments.adminUpdateReservation(user, id, dto.status, dto.note);
  }
}
