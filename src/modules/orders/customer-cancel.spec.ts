import { OrderStatus, PayableState, PaymentOption } from '@prisma/client';
import { customerCancelBlock } from './orders.service';

const order = (over: Partial<Parameters<typeof customerCancelBlock>[0]> = {}) => ({
  status: OrderStatus.PENDING,
  amountPaidMinor: 0n,
  paymentStatus: PayableState.UNPAID,
  paymentOption: PaymentOption.PAYSTACK,
  delivery: { status: 'PENDING' },
  ...over,
});

describe('customerCancelBlock: what a customer may cancel in the app', () => {
  it('lets an order waiting for online payment be cancelled', () => {
    expect(customerCancelBlock(order())).toBeNull();
  });

  it('lets a pay-on-delivery or pay-in-store order be cancelled before the team starts', () => {
    expect(customerCancelBlock(order({ status: OrderStatus.ACCEPTED, paymentOption: PaymentOption.PAY_ON_DELIVERY }))).toBeNull();
    expect(customerCancelBlock(order({ status: OrderStatus.ACCEPTED, paymentOption: PaymentOption.PAY_AT_LOCATION, delivery: null }))).toBeNull();
  });

  it('stops once the order is sent out or being prepared', () => {
    expect(customerCancelBlock(order({ status: OrderStatus.ACCEPTED, paymentOption: PaymentOption.PAY_ON_DELIVERY, delivery: { status: 'IN_TRANSIT' } }))).toMatch(/already started/);
    expect(customerCancelBlock(order({ status: OrderStatus.PROCESSING, paymentOption: PaymentOption.PAY_ON_DELIVERY }))).toMatch(/already started/);
  });

  it('sends paid orders to the team, saying they will refund', () => {
    expect(customerCancelBlock(order({ status: OrderStatus.ACCEPTED, amountPaidMinor: 1_000_000n, paymentStatus: PayableState.PAID }))).toMatch(/already paid.*refund/);
  });

  it('explains refunded and delivered orders', () => {
    expect(customerCancelBlock(order({ status: OrderStatus.ACCEPTED, paymentStatus: PayableState.REFUNDED }))).toMatch(/refunded/);
    expect(customerCancelBlock(order({ status: OrderStatus.DELIVERED, paymentOption: PaymentOption.PAY_ON_DELIVERY }))).toMatch(/delivered/);
  });
});
