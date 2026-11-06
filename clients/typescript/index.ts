/**
 * Small typed client for the Nimpat One customer API. Copy this folder into a
 * web or React Native project (it only needs `fetch`).
 *
 *   const api = createNimpatClient({ baseUrl: 'http://localhost:4000', tokens });
 *   const products = await api.products({ division: 'water-drinks-wines' });
 *
 * `schema.d.ts` is generated from the OpenAPI file (npm run client:generate)
 * and types every request. The API's OpenAPI file does not describe response
 * bodies yet, so the response types below are written by hand and are checked
 * against the running API by test/contract.e2e-spec.ts.
 * All money is whole kobo: 150000 = ₦1,500.00.
 */
import type { components } from './schema';

export type Dto = components['schemas'];
export type Purpose = 'ORDER' | 'APARTMENT_RESERVATION' | 'SERVICE_BOOKING' | 'SPA_APPOINTMENT' | 'VEHICLE_DEPOSIT' | 'LOGISTICS_REQUEST' | 'QUOTATION';
export type PaymentState = 'UNPAID' | 'AWAITING_VERIFICATION' | 'PARTIALLY_PAID' | 'PAID' | 'REFUNDED' | 'FAILED';
export type PaymentOption = 'PAYSTACK' | 'BANK_TRANSFER' | 'PAY_ON_DELIVERY' | 'PAY_AT_LOCATION';
export type OrderStatus = 'PENDING' | 'ACCEPTED' | 'PROCESSING' | 'READY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface Page<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }
export interface Variant { id: string; sku: string; name: string; unitPriceMinor: number; compareAtPriceMinor: number | null; availableQuantity: number; minOrderQty: number; maxOrderQty: number | null }
export interface Product { id: string; name: string; slug: string; brand: string | null; description: string | null; isAgeRestricted: boolean; priceFromMinor?: number | null; inStock?: boolean; images: { url: string; altText: string | null }[]; variants: Variant[]; category: { id: string; name: string; slug: string } | null }
export interface Tokens { accessToken: string; refreshToken: string; accessTokenExpiresIn: number; refreshTokenExpiresAt: string; tokenType: 'Bearer' }
export interface CartLine { itemId: string; variantId: string; sku: string; productName: string; productSlug: string; variantName: string; image: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number; availableQuantity: number; issues: string[] }
export interface Cart { cartId: string | null; currency: 'NGN'; lines: CartLine[]; itemCount: number; subtotalMinor: number; canCheckout: boolean }
export interface CartQuote extends Cart { deliveryFeeMinor: number; discountMinor: number; totalMinor: number }
export interface Order { id: string; orderNumber: string; status: OrderStatus; paymentStatus: PaymentState; paymentOption: PaymentOption; fulfilmentType: 'DELIVERY' | 'PICKUP'; subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number; amountPaidMinor: number; outstandingMinor: number; expiresAt: string | null; createdAt: string; items: { productName: string; variantName: string; sku: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[] }
export interface CheckoutOption { option: PaymentOption; available: boolean; reason?: string }
export interface PaystackStart { paymentId: string; reference: string; status: string; amountMinor: number; currency: string; authorizationUrl: string | null; accessCode: string | null; publicKey: string | null; reused: boolean }
export interface TransferInstructions { paymentId: string; reference: string; status: string; amountMinor: number; currency: string; payBy: string | null; account: { bankName: string; accountName: string; accountNumber: string } | null; narration: string; steps: string[] }
export interface PaymentSummary { purpose: Purpose; payableId: string; label: string; acceptsPayments: boolean; payBy: string | null; currency: string; totalDueMinor: number; depositRequiredMinor: number; paidMinor: number; refundedMinor: number; awaitingVerificationMinor: number; outstandingMinor: number; depositOutstandingMinor: number; depositSatisfied: boolean; fullyPaid: boolean; paymentStatus: PaymentState; payments: unknown[] }
export interface ApiErrorBody { statusCode: number; message: string | string[]; error?: string; requestId?: string }

export class NimpatApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(Array.isArray(body.message) ? body.message.join('; ') : body.message);
  }
}

export interface TokenStore {
  get(): { accessToken: string; refreshToken: string } | null;
  set(tokens: { accessToken: string; refreshToken: string } | null): void;
}

export function createNimpatClient({ baseUrl, tokens }: { baseUrl: string; tokens: TokenStore }) {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v1`;
  let refreshing: Promise<boolean> | null = null;

  const refresh = () =>
    (refreshing ??= (async () => {
      const t = tokens.get();
      if (!t) return false;
      const r = await fetch(`${api}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      if (!r.ok) {
        tokens.set(null);
        return false;
      }
      const n = (await r.json()) as Tokens;
      tokens.set({ accessToken: n.accessToken, refreshToken: n.refreshToken });
      return true;
    })().finally(() => (refreshing = null)));

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
    const t = tokens.get();
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: `Bearer ${t.accessToken}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry && t && (await refresh())) return request<T>(method, path, body, headers, false);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new NimpatApiError(res.status, data);
    return data as T;
  }
  const qs = (o: Record<string, unknown>) => {
    const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
    return s ? `?${s}` : '';
  };
  const idem = (key?: string): Record<string, string> => (key ? { 'Idempotency-Key': key } : {});
  const saveSession = <R extends Tokens>(r: R) => {
    tokens.set({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r;
  };

  return {
    request,
    /** Absolute URL for a /media/... image path returned by the API. */
    mediaUrl: (path: string | null | undefined) => (path && path.startsWith('/') ? `${baseUrl.replace(/\/$/, '')}${path}` : path ?? null),

    // Account
    register: (b: Dto['RegisterDto']) => request<Tokens & { user: { id: string; email: string; emailVerified: boolean } }>('POST', '/auth/register', b).then(saveSession),
    login: (b: Dto['LoginDto']) => request<Tokens & { user: { id: string; email: string; emailVerified: boolean; type: string } }>('POST', '/auth/login', b).then(saveSession),
    logout: () => request('POST', '/auth/logout').finally(() => tokens.set(null)),
    verifyEmail: (token: string) => request('POST', '/auth/verify-email', { token }),
    forgotPassword: (email: string) => request('POST', '/auth/forgot-password', { email }),
    resetPassword: (token: string, newPassword: string) => request('POST', '/auth/reset-password', { token, newPassword }),
    me: () => request<any>('GET', '/auth/me'),
    updateProfile: (b: Dto['UpdateProfileDto']) => request<any>('PATCH', '/me/profile', b),
    addresses: () => request<any[]>('GET', '/me/addresses'),
    addAddress: (b: Dto['CreateAddressDto']) => request<any>('POST', '/me/addresses', b),

    // Catalogue
    divisions: () => request<{ id: string; code: string; name: string; slug: string; kind: string; description: string | null }[]>('GET', '/divisions'),
    categories: (division: string) => request<{ id: string; name: string; slug: string }[]>('GET', `/catalog/categories${qs({ division })}`),
    products: (q: { division?: string; category?: string; q?: string; page?: number; pageSize?: number }) => request<Page<Product>>('GET', `/catalog/products${qs(q)}`),
    product: (slug: string) => request<Product>('GET', `/catalog/products/${encodeURIComponent(slug)}`),

    // Cart & checkout
    cart: (division: string) => request<Cart>('GET', `/carts/${division}`),
    addToCart: (variantId: string, quantity: number) => request<Cart>('POST', '/carts/items', { variantId, quantity }),
    setCartQuantity: (variantId: string, quantity: number) => request<Cart>('PATCH', `/carts/items/${variantId}`, { quantity }),
    removeFromCart: (variantId: string) => request<Cart>('DELETE', `/carts/items/${variantId}`),
    cartQuote: (division: string, fulfilmentType: 'DELIVERY' | 'PICKUP', addressId?: string) => request<CartQuote>('GET', `/carts/${division}/quote${qs({ fulfilmentType, addressId })}`),
    checkoutOptions: (division: string, fulfilmentType: 'DELIVERY' | 'PICKUP', addressId?: string) => request<{ orderValueMinor: number; options: CheckoutOption[] }>('GET', `/orders/checkout-options${qs({ division, fulfilmentType, addressId })}`),
    placeOrder: (b: { division: string; fulfilmentType: 'DELIVERY' | 'PICKUP'; addressId?: string; paymentOption?: PaymentOption; customerNote?: string; expectedTotalMinor?: number }, idempotencyKey?: string) => request<Order>('POST', '/orders', b, idem(idempotencyKey)),
    orders: (q: { page?: number; pageSize?: number; status?: OrderStatus } = {}) => request<Page<Order>>('GET', `/orders${qs(q)}`),
    order: (id: string) => request<Order>('GET', `/orders/${id}`),
    cancelOrder: (id: string) => request<Order>('POST', `/orders/${id}/cancel`),

    // Payments
    paymentMethods: (division: string, purpose: Purpose) => request<any>('GET', `/payments/methods${qs({ division, purpose })}`),
    paymentOptions: (purpose: Purpose, payableId: string) => request<any>('GET', `/payments/options${qs({ purpose, payableId })}`),
    paymentSummary: (purpose: Purpose, payableId: string) => request<PaymentSummary>('GET', `/payments/summary${qs({ purpose, payableId })}`),
    payWithPaystack: (purpose: Purpose, payableId: string, amountOption?: 'BALANCE' | 'DEPOSIT', idempotencyKey?: string) => request<PaystackStart>('POST', '/payments/initialize', { purpose, payableId, amountOption }, idem(idempotencyKey)),
    verifyPaystack: (reference: string) => request<any>('POST', `/payments/verify/${encodeURIComponent(reference)}`),
    startBankTransfer: (purpose: Purpose, payableId: string, amountOption?: 'BALANCE' | 'DEPOSIT', idempotencyKey?: string) => request<TransferInstructions>('POST', '/payments/bank-transfer', { purpose, payableId, amountOption }, idem(idempotencyKey)),
    notifyTransfer: (reference: string, b: Dto['TransferNoticeDto']) => request<any>('POST', `/payments/bank-transfer/${encodeURIComponent(reference)}/notify`, b),
    receipt: (reference: string) => request<any>('GET', `/payments/receipts/${encodeURIComponent(reference)}`),

    // Apartments
    properties: (q: { city?: string; checkIn?: string; checkOut?: string; guests?: number; page?: number } = {}) => request<Page<any>>('GET', `/apartments/properties${qs(q)}`),
    property: (slug: string) => request<any>('GET', `/apartments/properties/${encodeURIComponent(slug)}`),
    unitCalendar: (unitId: string, from: string, to: string) => request<{ unavailable: { start: string; end: string; type: string }[] }>('GET', `/apartments/units/${unitId}/calendar${qs({ from, to })}`),
    unitQuote: (unitId: string, checkIn: string, checkOut: string, guests?: number) => request<any>('GET', `/apartments/units/${unitId}/quote${qs({ checkIn, checkOut, guests })}`),
    reserve: (b: Dto['CreateReservationDto'], idempotencyKey?: string) => request<any>('POST', '/apartments/reservations', b, idem(idempotencyKey)),
    reservations: () => request<Page<any>>('GET', '/apartments/reservations'),
    cancelReservation: (id: string, reason?: string) => request<any>('POST', `/apartments/reservations/${id}/cancel`, { reason }),

    // Vehicles
    vehicles: (q: { make?: string; condition?: string; page?: number; pageSize?: number } = {}) => request<Page<any>>('GET', `/vehicles${qs(q)}`),
    vehicle: (slug: string) => request<any>('GET', `/vehicles/${encodeURIComponent(slug)}`),
    inquireVehicle: (vehicleId: string, b: Record<string, unknown>) => request<any>('POST', `/vehicles/${vehicleId}/inquiries`, b),

    // Spa
    treatments: () => request<any[]>('GET', '/spa/treatments'),
    treatment: (slug: string) => request<any>('GET', `/spa/treatments/${encodeURIComponent(slug)}`),
    treatmentSlots: (treatmentId: string, date: string, practitionerId?: string) => request<any>('GET', `/spa/treatments/${treatmentId}/slots${qs({ date, practitionerId })}`),
    bookTreatment: (b: { treatmentId: string; startsAt: string; practitionerId?: string; customerNote?: string }) => request<any>('POST', '/spa/appointments', b),
    appointments: () => request<Page<any>>('GET', '/spa/appointments'),

    // Green Wallet & notifications
    wallet: () => request<{ account: { pointsBalance: number; lifetimeEarned: number; tier: string }; history: Page<any> }>('GET', '/loyalty/me'),
    earningRules: () => request<any[]>('GET', '/loyalty/rules'),
    notifications: () => request<Page<any> & { unreadCount: number }>('GET', '/notifications'),
  };
}
