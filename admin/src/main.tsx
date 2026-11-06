import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, Building2, CalendarCheck, CalendarClock, Car, ClipboardCheck, Clapperboard, Droplets, Landmark, LayoutDashboard, LogOut,
  Package, Pill, Search, Settings2, ShoppingBag, Sparkles, Truck, Users, Wallet, type LucideIcon,
} from 'lucide-react';
import { AccessProvider, useAccess, type Check } from './access';
import { get, getSession, logout } from './api';
import { ToastProvider } from './components/ui';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ProductsPage } from './pages/Products';
import { StockPage } from './pages/Stock';
import { ApartmentsPage } from './pages/Apartments';
import { SpaPage } from './pages/Spa';
import { VehiclesPage } from './pages/Vehicles';
import { ServicesPage } from './pages/Services';
import { OrdersPage } from './pages/Orders';
import { ReservationsPage } from './pages/Reservations';
import { BookingsPage } from './pages/Bookings';
import { DeliveryPage } from './pages/Delivery';
import { PaymentsPage } from './pages/Payments';
import { PaymentSettingsPage } from './pages/PaymentSettings';
import { DataCheckPage } from './pages/DataCheck';
import { SetPasswordPage } from './pages/SetPassword';
import { StaffPage } from './pages/Staff';
import './theme.css';

function useSession() {
  const [session, setSession] = useState(getSession());
  useEffect(() => {
    const on = () => setSession(getSession());
    window.addEventListener('nimpat-session', on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener('nimpat-session', on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return session;
}

// The last item says who sees the page: a permission, optionally limited to one division.
const NAV: { group: string; items: [string, string, LucideIcon, Check?][] }[] = [
  { group: '', items: [['/', 'Overview', LayoutDashboard]] },
  { group: 'Products', items: [
    ['/drinks', 'Water, Drinks & Wines', Droplets, { any: ['catalog:manage'], division: 'water-drinks-wines' }],
    ['/retail', 'Retail & Supplies', ShoppingBag, { any: ['catalog:manage'], division: 'retail-general-supplies' }],
    ['/pharmacy', 'Pharmacy', Pill, { any: ['catalog:manage'], division: 'pharmacy-laboratory' }],
    ['/stock', 'Stock', Package, { any: ['inventory:read', 'inventory:manage'], division: ['water-drinks-wines', 'retail-general-supplies', 'pharmacy-laboratory'] }],
    ['/delivery', 'Delivery fees', Truck, { any: ['deliveries:manage'], division: 'water-drinks-wines' }],
  ] },
  { group: 'Bookings & listings', items: [
    ['/apartments', 'Apartments', Building2, { any: ['listings:manage'], division: 'luxury-apartments' }],
    ['/spa', 'Spa & Wellness', Sparkles, { any: ['listings:manage'], division: 'spa-wellness' }],
    ['/vehicles', 'Automobiles', Car, { any: ['listings:manage'], division: 'automobiles' }],
    ['/services', 'Rentals & property', Clapperboard, { any: ['listings:manage'], division: ['automobiles', 'transport-logistics', 'retail-general-supplies', 'media-events-rentals', 'real-estate-interior-design', 'entertainment', 'pharmacy-laboratory'] }],
  ] },
  { group: 'Customers', items: [
    ['/orders', 'Orders', Landmark, { any: ['orders:read'], division: ['water-drinks-wines', 'retail-general-supplies', 'pharmacy-laboratory'] }],
    ['/reservations', 'Reservations', CalendarCheck, { any: ['bookings:read'], division: 'luxury-apartments' }],
    ['/bookings', 'Bookings', CalendarClock, { any: ['bookings:read'] }],
  ] },
  { group: 'Finance', items: [
    ['/payments', 'Payments', Wallet, { any: ['payments:read', 'payments:verify', 'payments:configure', 'collections:record'] }],
    ['/payment-settings', 'Payment settings', Settings2, { any: ['payments:configure'] }],
  ] },
  { group: 'Team and data', items: [
    ['/staff', 'Staff and managers', Users, { any: ['staff:manage', 'roles:assign'] }],
    ['/data-check', 'Data confirmation', ClipboardCheck, { any: ['records:verify', 'reports:read'] }],
  ] },
];

/** Payments reported by customers or staff, waiting for finance. */
function usePendingVerifications() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => get<{ meta: { total: number } }>('/admin/payments?status=AWAITING_VERIFICATION&pageSize=1').then((r) => alive && setCount(r.meta.total)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return count;
}

function Shell({ email }: { email: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const pending = usePendingVerifications();
  const { can } = useAccess();
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter(([, , , check]) => !check || can(check)) })).filter((g) => g.items.length);
  return (
    <div className="frame">
      <header className="topbar">
        <Link to="/" className="logo">
          <span className="logo-mark" aria-hidden="true">N1</span>
          <div><strong>Nimpat One</strong><span>Admin dashboard</span></div>
        </Link>
        <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); navigate(`/drinks?q=${encodeURIComponent(q.trim())}`); }}>
          <Search size={17} aria-hidden="true" />
          <input aria-label="Search products" placeholder="Search products by name, brand or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="top-actions">
          <Link to="/payments" className="icon-btn" aria-label={`${pending} payments awaiting verification`} title="Payments awaiting verification">
            <Bell size={18} />
            {pending > 0 && <span className="badge">{pending}</span>}
          </Link>
          <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void logout()}><LogOut size={18} /></button>
          <span className="avatar" title={email}>{email.slice(0, 2)}</span>
        </div>
      </header>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <div className="nav-title">Manage</div>
          {nav.map((g) => (
            <div key={g.group || 'top'}>
              {g.group && <div className="nav-group">{g.group}</div>}
              {g.items.map(([to, label, Icon]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  <Icon size={17} aria-hidden="true" />
                  {label}
                  {to === '/payments' && pending > 0 && <span className="nav-count">{pending}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="sidebar-foot" style={{ wordBreak: 'break-all' }}>{email}</div>
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function App() {
  const session = useSession();
  const { pathname } = useLocation();
  if (pathname === '/reset-password') return <SetPasswordPage />;
  if (!session) return <LoginPage />;
  return (
    <AccessProvider key={session.email}>
    <Routes>
      <Route element={<Shell email={session.email} />}>
        <Route index element={<OverviewPage />} />
        <Route path="drinks" element={<ProductsPage key="wdw" division="water-drinks-wines" title="Water, Drinks & Wines" />} />
        <Route path="retail" element={<ProductsPage key="rtl" division="retail-general-supplies" title="Retail & General Supplies" />} />
        <Route path="pharmacy" element={<ProductsPage key="phm" division="pharmacy-laboratory" title="Pharmacy" />} />
        <Route path="stock" element={<StockPage />} />
        <Route path="delivery" element={<DeliveryPage />} />
        <Route path="apartments" element={<ApartmentsPage />} />
        <Route path="spa" element={<SpaPage />} />
        <Route path="vehicles" element={<VehiclesPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="reservations" element={<ReservationsPage />} />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="payment-settings" element={<PaymentSettingsPage />} />
        <Route path="staff" element={<StaffPage />} />
        <Route path="data-check" element={<DataCheckPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </AccessProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
