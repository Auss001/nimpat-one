/**
 * What the Android and iPhone apps need beyond the website: the phone's back button, the status bar, the splash
 * screen, and paying in the phone's browser and coming back. In a normal browser every function here does nothing.
 */
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNativeApp = Capacitor.isNativePlatform();

export function startNativeApp(navigate: (to: string) => void) {
  if (!isNativeApp) return;
  void StatusBar.setStyle({ style: Style.Light }).catch(() => undefined);
  if (Capacitor.getPlatform() === 'android') void StatusBar.setBackgroundColor({ color: '#eef3ee' }).catch(() => undefined);
  void SplashScreen.hide().catch(() => undefined);
  // Android back button: go back a page, or leave the app from the home screen.
  void App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && window.location.pathname !== '/') window.history.back();
    else void App.exitApp();
  });
  appNavigate = navigate;
  // The customer closed the payment window themselves: show the result in the app.
  void Browser.addListener('browserFinished', () => finishPayment());
}

let pendingPayment: string | null = null;
let appNavigate: ((to: string) => void) | null = null;
let watcher: ReturnType<typeof setInterval> | null = null;

/** Leaves the payment window (if open) and shows the payment result inside the app. */
function finishPayment() {
  if (watcher) clearInterval(watcher);
  watcher = null;
  const reference = pendingPayment;
  pendingPayment = null;
  if (reference && appNavigate) appNavigate(`/payments/callback?reference=${encodeURIComponent(reference)}`);
}

/**
 * Opens Paystack: in the app, in a payment window over the app; on the web, in this tab. In the app, the payment is
 * checked every few seconds while the window is open, and as soon as Paystack confirms it the window closes by itself
 * and the app shows the result, so the customer never lands on the website.
 */
export async function openPayment(url: string, reference: string) {
  if (!isNativeApp) {
    window.location.assign(url);
    return;
  }
  pendingPayment = reference;
  await Browser.open({ url, presentationStyle: 'fullscreen', toolbarColor: '#0b6b3a' });
  if (watcher) clearInterval(watcher);
  const started = Date.now();
  watcher = setInterval(async () => {
    if (!pendingPayment || Date.now() - started > 20 * 60_000) {
      if (watcher) clearInterval(watcher);
      watcher = null;
      return;
    }
    try {
      const { post } = await import('./api');
      const r = await post<{ status?: string }>(`/payments/verify/${encodeURIComponent(reference)}`);
      if (r?.status === 'SUCCESS' || r?.status === 'FAILED') {
        await Browser.close().catch(() => undefined);
        finishPayment();
      }
    } catch {
      /* Not confirmed yet, or offline for a moment: keep waiting. */
    }
  }, 3000);
}

/** In the app, Paystack returns to a plain page instead of the website. */
export const paymentReturn = isNativeApp ? 'app' : 'web';

// ---------------------------------------------------------------- notifications on the phone

const PUSH_TOKEN = 'nimpat-one-push-token';
let pushListening = false;

/**
 * Once someone has a session in the phone app: ask to send notifications, and tell the server where to send them.
 * A tap on a notification opens the matching page (for example the order). Does nothing on the website.
 */
export async function startPush(navigate: (to: string) => void) {
  if (!isNativeApp) return;
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const { post } = await import('./api');
    let { receive } = await FirebaseMessaging.checkPermissions();
    if (receive === 'prompt' || receive === 'prompt-with-rationale') receive = (await FirebaseMessaging.requestPermissions()).receive;
    if (receive !== 'granted') return;
    const send = async (token: string) => {
      await post('/notifications/devices', { token, platform: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android' });
      try { localStorage.setItem(PUSH_TOKEN, token); } catch { /* Kept for this run only. */ }
    };
    if (!pushListening) {
      pushListening = true;
      void FirebaseMessaging.addListener('tokenReceived', ({ token }) => void send(token).catch(() => undefined));
      void FirebaseMessaging.addListener('notificationActionPerformed', ({ notification }) => {
        const path = (notification.data as { path?: string } | undefined)?.path;
        if (path && path.startsWith('/')) navigate(path);
      });
    }
    const { token } = await FirebaseMessaging.getToken();
    if (token) await send(token);
  } catch {
    /* Notifications are a bonus: the app works without them. */
  }
}

/** On sign-out, stop notifications for this account on this phone. */
export async function stopPush() {
  if (!isNativeApp) return;
  try {
    const token = localStorage.getItem(PUSH_TOKEN);
    if (!token) return;
    const { post } = await import('./api');
    await post('/notifications/devices/remove', { token });
    localStorage.removeItem(PUSH_TOKEN);
  } catch {
    /* Already signed out or offline: the server forgets stale phones by itself. */
  }
}
