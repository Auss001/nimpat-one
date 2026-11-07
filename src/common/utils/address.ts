import { BadRequestException } from '@nestjs/common';
import { Address, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A copy of an address, kept on an order or booking so later edits to the address book do not move it. */
export function snapshotAddress(a: Address): Prisma.InputJsonValue {
  return {
    recipientName: a.recipientName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    lga: a.lga,
    state: a.state,
    country: a.country,
    latitude: a.latitude,
    longitude: a.longitude,
  };
}

/** One of the customer's own saved addresses, as a copy for a home visit. */
export async function homeAddressFor(prisma: PrismaService, userId: string, addressId: string | undefined): Promise<Prisma.InputJsonValue> {
  if (!addressId) throw new BadRequestException('Please choose the address we should come to');
  const a = await prisma.address.findFirst({ where: { id: addressId, userId, deletedAt: null } });
  if (!a) throw new BadRequestException('That address was not found. Please choose another one.');
  return snapshotAddress(a);
}
