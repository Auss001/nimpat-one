import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { CalendarCheck, Crown, Heart, Home, Search, ShoppingBasket, User } from 'lucide-react';
import { startNativeApp, startPush } from './native';
import { hideSplash } from './splash';
import { CartProvider, FavoritesProvider, ToastProvider, useCart, useSession } from './ui';
import { HomePage } from './pages/Home';
import { DeleteAccountPage, PrivacyPage, TermsPage } from './pages/Legal';
import { FavoritesPage } from './pages/Favorites';
import { PharmacyPage, ProductPage, SearchPage, ShopPage } from './pages/Shop';
import { CartPage, CheckoutPage, PaymentCallbackPage, PayPage } from './pages/Cart';
import { ApartmentPage, ApartmentsPage } from './pages/Apartments';
import { CarPage, CarsPage } from './pages/Cars';
import { ServicesPage, SpaPage, TreatmentPage } from './pages/Bookable';
import { AccountPage, RoyaltyPage, BookingsPage, ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyEmailPage } from './pages/Account';
import { HelpPage, WhatsAppButton } from './pages/Help';
import { TrackOrderPage } from './pages/Track';
import { formatNaira } from './api';
import './theme.css';

const TABS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/cart', label: 'Basket', icon: ShoppingBasket },
  { to: '/bookings', label: 'Orders', icon: CalendarCheck },
  { to: '/account', label: 'Account', icon: User },
];

function Shell() {
  const { count, totalMinor } = useCart();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  // Phone apps only: back button, status bar, splash screen, returning from a payment.
  useEffect(() => startNativeApp(navigate), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The opening screen in index.html fades once the app has drawn.
  useEffect(() => hideSplash(), []);
  const session = useSession();
  // Phone apps: notifications once someone has given their details or signed in.
  useEffect(() => {
    if (session) void startPush(navigate);
  }, [session?.email]); // eslint-disable-line react-hooks/exhaustive-deps
  // Braces matter: newer browsers return a promise from scrollTo, and React would treat it as a cleanup.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="shell">
      <header className="top">
        <div className="top-in">
          <Link to="/" className="brand" aria-label="Nimpat One home"><img src="/nimpat-one-logo.webp" alt="Nimpat One" /></Link>
          <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <Search size={17} aria-hidden="true" />
            <input aria-label="Search Nimpat One" placeholder="What do you need?" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <nav className="top-nav" aria-label="Shortcuts">
            <Link to="/royalty" className="top-icon royalty-icon" aria-label="Royalty Member" title="Royalty Member"><Crown size={20} aria-hidden="true" /></Link>
            <Link to="/favorites" className="top-icon" aria-label="Favourites"><Heart size={20} aria-hidden="true" /></Link>
            <Link to="/bookings" className="top-icon wide-only" aria-label="Orders"><CalendarCheck size={20} aria-hidden="true" /></Link>
            <Link to="/account" className="top-icon wide-only" aria-label="Account"><User size={20} aria-hidden="true" /></Link>
            <Link to="/cart" className="top-icon wide-only" aria-label={`Basket, ${count} items`}><ShoppingBasket size={20} aria-hidden="true" />{count > 0 && <em>{count}</em>}</Link>
          </nav>
        </div>
      </header>
      <main className="main" key={pathname}><Outlet /></main>
      <WhatsAppButton raised={count > 0 && pathname !== '/cart' && !pathname.startsWith('/checkout')} />
      {count > 0 && pathname !== '/cart' && !pathname.startsWith('/checkout') && (
        <Link to="/cart" className="float-basket"><span><b>{count}</b> View basket</span><span>{formatNaira(totalMinor)}</span></Link>
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
          <FavoritesProvider>
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
              <Route path="favorites" element={<FavoritesPage />} />
              <Route path="cart" element={<CartPage />} />
              <Route path="checkout/:division" element={<CheckoutPage />} />
              <Route path="pay/:purpose/:id" element={<PayPage />} />
              <Route path="payments/callback" element={<PaymentCallbackPage />} />
              <Route path="bookings" element={<BookingsPage />} />
              <Route path="orders/:id" element={<TrackOrderPage />} />
              <Route path="help" element={<HelpPage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="royalty" element={<RoyaltyPage />} />
              <Route path="privacy" element={<PrivacyPage />} />
              <Route path="terms" element={<TermsPage />} />
              <Route path="delete-account" element={<DeleteAccountPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="forgot-password" element={<ForgotPage />} />
              <Route path="reset-password" element={<ResetPage />} />
              <Route path="verify-email" element={<VerifyEmailPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          </FavoritesProvider>
        </CartProvider>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
