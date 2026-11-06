import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { CalendarCheck, Home, Search, ShoppingBasket, User } from 'lucide-react';
import { CartProvider, ToastProvider, useCart, useSession } from './ui';
import { HomePage, Wordmark } from './pages/Home';
import { PharmacyPage, ProductPage, SearchPage, ShopPage } from './pages/Shop';
import { CartPage, CheckoutPage, PaymentCallbackPage, PayPage } from './pages/Cart';
import { ApartmentPage, ApartmentsPage } from './pages/Apartments';
import { CarPage, CarsPage } from './pages/Cars';
import { ServicesPage, SpaPage, TreatmentPage } from './pages/Bookable';
import { AccountPage, BookingsPage, ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyEmailPage } from './pages/Account';
import './theme.css';

const TABS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/cart', label: 'Basket', icon: ShoppingBasket },
  { to: '/bookings', label: 'Bookings', icon: CalendarCheck },
  { to: '/account', label: 'Account', icon: User },
];

function Shell() {
  const { count } = useCart();
  const session = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  // Braces matter: newer browsers return a promise from scrollTo, and React would treat it as a cleanup.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="shell">
      <header className="top">
        <div className="top-in">
          <Link to="/" className="brand" aria-label="Nimpat One home"><img src="/logo.webp" alt="" width="34" height="34" /><Wordmark /></Link>
          <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <Search size={17} aria-hidden="true" />
            <input aria-label="Search Nimpat One" placeholder="Search water, medicine, stays, cars…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <nav className="top-nav" aria-label="Main">
            <NavLink to="/bookings">Bookings</NavLink>
            <NavLink to="/account">{session?.firstName ?? (session ? 'Account' : 'Sign in')}</NavLink>
            <Link to="/cart" className="basket-pill" aria-label={`Basket, ${count} items`}><ShoppingBasket size={18} aria-hidden="true" /> {count}</Link>
          </nav>
        </div>
      </header>
      <main className="main"><Outlet /></main>
      {count > 0 && pathname !== '/cart' && !pathname.startsWith('/checkout') && (
        <Link to="/cart" className="float-basket"><ShoppingBasket size={18} aria-hidden="true" /> View basket <b>{count}</b></Link>
      )}
      <nav className="tabs" aria-label="Main">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}>
            <span className="tab-icon"><Icon size={22} aria-hidden="true" />{to === '/cart' && count > 0 && <em>{count}</em>}</span>
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <CartProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<HomePage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="shop/:division" element={<ShopPage />} />
              <Route path="pharmacy" element={<PharmacyPage />} />
              <Route path="product/:slug" element={<ProductPage />} />
              <Route path="apartments" element={<ApartmentsPage />} />
              <Route path="apartments/:slug" element={<ApartmentPage />} />
              <Route path="cars" element={<CarsPage />} />
              <Route path="cars/:slug" element={<CarPage />} />
              <Route path="spa" element={<SpaPage />} />
              <Route path="spa/:slug" element={<TreatmentPage />} />
              <Route path="services/:division" element={<ServicesPage />} />
              <Route path="cart" element={<CartPage />} />
              <Route path="checkout/:division" element={<CheckoutPage />} />
              <Route path="pay/:purpose/:id" element={<PayPage />} />
              <Route path="payments/callback" element={<PaymentCallbackPage />} />
              <Route path="bookings" element={<BookingsPage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="forgot-password" element={<ForgotPage />} />
              <Route path="reset-password" element={<ResetPage />} />
              <Route path="verify-email" element={<VerifyEmailPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </CartProvider>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
