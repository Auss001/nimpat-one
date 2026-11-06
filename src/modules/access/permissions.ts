import { RoleCode } from '@prisma/client';

/**
 * Single source of truth for permissions and the default role matrix.
 * The seed writes these to the roles / permissions tables; the guard reads
 * the tables at request time so grants can be changed without a deploy.
 */
export const P = {
  divisionsManage: 'divisions:manage',
  catalogManage: 'catalog:manage',
  inventoryRead: 'inventory:read',
  inventoryManage: 'inventory:manage',
  ordersRead: 'orders:read',
  ordersManage: 'orders:manage',
  deliveriesManage: 'deliveries:manage',
  paymentsRead: 'payments:read',
  paymentsRefund: 'payments:refund',
  paymentsReconcile: 'payments:reconcile',
  listingsManage: 'listings:manage', // properties, units, vehicles, treatments, offerings
  bookingsRead: 'bookings:read', // reservations, appointments, service bookings
  bookingsManage: 'bookings:manage',
  inquiriesManage: 'inquiries:manage',
  logisticsManage: 'logistics:manage',
  quotationsManage: 'quotations:manage',
  loyaltyManage: 'loyalty:manage',
  notificationsSend: 'notifications:send',
  customersRead: 'customers:read',
  staffManage: 'staff:manage',
  rolesAssign: 'roles:assign',
  reportsRead: 'reports:read',
  auditRead: 'audit:read',
  collectionsRecord: 'collections:record', // delivery officers & cashiers record money received
  paymentsVerify: 'payments:verify', // finance confirms funds against trusted bank / cash records
  paymentsConfigure: 'payments:configure', // bank accounts, payment policies, service locations
  recordsVerify: 'records:verify', // confirm catalogue / listing data before it can be sold or booked
} as const;

export type PermissionCode = (typeof P)[keyof typeof P];
export const ALL_PERMISSIONS: PermissionCode[] = Object.values(P);

const READ_ONLY: PermissionCode[] = [
  P.inventoryRead,
  P.ordersRead,
  P.paymentsRead,
  P.bookingsRead,
  P.customersRead,
  P.reportsRead,
  P.auditRead,
];

export const ROLE_DEFINITIONS: Record<
  RoleCode,
  { name: string; description: string; isDivisionScoped: boolean; permissions: PermissionCode[] }
> = {
  SUPER_ADMIN: {
    name: 'Super Administrator',
    description: 'Full platform control, including role assignment and configuration.',
    isDivisionScoped: false,
    permissions: ALL_PERMISSIONS,
  },
  GROUP_MANAGEMENT: {
    name: 'Group Management',
    description: 'Group-wide oversight: reports, audit trail and read access to all divisions.',
    isDivisionScoped: false,
    permissions: [...READ_ONLY, P.paymentsReconcile, P.loyaltyManage, P.notificationsSend],
  },
  DEPARTMENT_MANAGER: {
    name: 'Department Manager',
    description: 'Manages one division: catalogue, stock, orders, bookings, refunds and staff.',
    isDivisionScoped: true,
    permissions: [
      ...READ_ONLY.filter((p) => p !== P.auditRead),
      P.catalogManage,
      P.inventoryManage,
      P.ordersManage,
      P.deliveriesManage,
      P.paymentsRefund,
      P.listingsManage,
      P.bookingsManage,
      P.inquiriesManage,
      P.logisticsManage,
      P.quotationsManage,
      P.notificationsSend,
      P.rolesAssign,
      P.collectionsRecord,
      P.recordsVerify,
    ],
  },
  DEPARTMENT_STAFF: {
    name: 'Department Staff',
    description: 'Day-to-day operations within one division.',
    isDivisionScoped: true,
    permissions: [
      P.inventoryRead,
      P.inventoryManage,
      P.ordersRead,
      P.ordersManage,
      P.deliveriesManage,
      P.bookingsRead,
      P.bookingsManage,
      P.inquiriesManage,
      P.logisticsManage,
      P.quotationsManage,
      P.customersRead,
      P.collectionsRecord, // delivery officers / cashiers: report collections, never verify them
    ],
  },
  FINANCE_OFFICER: {
    name: 'Finance Officer',
    description: 'Group finance: verifies bank transfers and cash collections against trusted records, reconciles, refunds and resolves disputes.',
    isDivisionScoped: false,
    permissions: [P.paymentsRead, P.paymentsVerify, P.paymentsReconcile, P.paymentsRefund, P.ordersRead, P.bookingsRead, P.customersRead, P.reportsRead],
  },
  CUSTOMER_SUPPORT: {
    name: 'Customer Support',
    description: 'Group-wide support: view customers, orders, bookings and payments; handle inquiries.',
    isDivisionScoped: false,
    permissions: [P.ordersRead, P.paymentsRead, P.bookingsRead, P.customersRead, P.inquiriesManage, P.notificationsSend],
  },
  CUSTOMER: {
    name: 'Customer',
    description: 'Default role for customer accounts. Access is limited to the customer’s own records.',
    isDivisionScoped: false,
    permissions: [],
  },
};

/** Which roles an assigner may grant. Super admins can grant anything. */
export const GRANTABLE_BY: Record<RoleCode, RoleCode[]> = {
  SUPER_ADMIN: ['SUPER_ADMIN', 'GROUP_MANAGEMENT', 'DEPARTMENT_MANAGER', 'DEPARTMENT_STAFF', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER'],
  FINANCE_OFFICER: [],
  GROUP_MANAGEMENT: [],
  DEPARTMENT_MANAGER: ['DEPARTMENT_STAFF'],
  DEPARTMENT_STAFF: [],
  CUSTOMER_SUPPORT: [],
  CUSTOMER: [],
};
