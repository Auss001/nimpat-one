import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.phone) {
      const taken = await this.prisma.user.findFirst({ where: { phone: dto.phone, id: { not: userId } }, select: { id: true } });
      if (taken) throw new ConflictException('This phone number is already in use');
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.phone !== undefined) await tx.user.update({ where: { id: userId }, data: { phone: dto.phone } });
      const profileData = {
        firstName: dto.firstName,
        lastName: dto.lastName,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        marketingOptIn: dto.marketingOptIn,
      };
      const existing = await tx.customerProfile.findUnique({ where: { userId } });
      if (existing) return tx.customerProfile.update({ where: { userId }, data: profileData });
      return tx.customerProfile.create({
        data: {
          userId,
          firstName: dto.firstName ?? '',
          lastName: dto.lastName ?? '',
          dateOfBirth: profileData.dateOfBirth,
          marketingOptIn: profileData.marketingOptIn,
        },
      });
    });
  }

  listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getOwnedAddress(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({ where: { id, userId, deletedAt: null } });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  async createAddress(userId: string, dto: CreateAddressDto) {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId, deletedAt: null } });
      if (count >= 20) throw new ConflictException('Address book limit reached (20)');
      const makeDefault = dto.isDefault || count === 0;
      if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({ data: { ...dto, userId, isDefault: makeDefault } });
    });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto) {
    await this.getOwnedAddress(userId, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: dto });
    });
  }

  /** Soft delete: past orders keep their own address snapshot. */
  async deleteAddress(userId: string, id: string) {
    await this.getOwnedAddress(userId, id);
    await this.prisma.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
    return { ok: true };
  }
}
