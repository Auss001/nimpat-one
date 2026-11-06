import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Bell, Building2, CalendarCheck, Car, ClipboardCheck, Clapperboard, Droplets, Landmark, LayoutDashboard, LogOut,
  Package, Search, Settings2, ShoppingBag, Sparkles, Truck, Wallet, type LucideIcon,
} from 'lucide-react';
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
import { DeliveryPage } from './pages/Delivery';
import { PaymentsPage } from './pages/Payments';
import { PaymentSettingsPage } from './pages/PaymentSettings';
import { DataCheckPage } from './pages/DataCheck';
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

const NAV: { group: string; items: [string, string, LucideIcon][] }[] = [
  { group: '', items: [['/', 'Overview', LayoutDashboard]] },
  { group: 'Products', items: [['/drinks', 'Water, Drinks & Wines', Droplets], ['/retail', 'Retail & Supplies', ShoppingBag], ['/stock', 'Stock', Package], ['/delivery', 'Delivery fees', Truck]] },
  { group: 'Bookings & listings', items: [['/apartments', 'Apartments', Building2], ['/spa', 'Spa & Wellness', Sparkles], ['/vehicles', 'Automobiles', Car], ['/services', 'Rentals & property', Clapperboard]] },
  { group: 'Customers', items: [['/orders', 'Orders', Landmark], ['/reservations', 'Reservations', CalendarCheck]] },
  { group: 'Finance', items: [['/payments', 'Payments', Wallet], ['/payment-settings', 'Payment settings', Settings2]] },
  { group: 'Data', items: [['/data-check', 'Data confirmation', ClipboardCheck]] },
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
          {NAV.map((g) => (
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
  if (!session) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Shell email={session.email} />}>
        <Route index element={<OverviewPage />} />
        <Route path="drinks" element={<ProductsPage key="wdw" division="water-drinks-wines" title="Water, Drinks & Wines" />} />
        <Route path="retail" element={<ProductsPage key="rtl" division="retail-general-supplies" title="Retail & General Supplies" />} />
        <Route path="stock" element={<StockPage />} />
        <Route path="delivery" element={<DeliveryPage />} />
        <Route path="apartments" element={<ApartmentsPage />} />
        <Route path="spa" element={<SpaPage />} />
        <Route path="vehicles" element={<VehiclesPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="reservations" element={<ReservationsPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="payment-settings" element={<PaymentSettingsPage />} />
        <Route path="data-check" element={<DataCheckPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
