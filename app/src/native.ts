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
  // A payment finished in the phone's browser: check it as soon as the customer is back.
  void Browser.addListener('browserFinished', () => {
    const reference = pendingPayment;
    pendingPayment = null;
    if (reference) navigate(`/payments/callback?reference=${encodeURIComponent(reference)}`);
  });
}

let pendingPayment: string | null = null;

/** Opens Paystack: in the app, in the phone's own browser sheet; on the web, in this tab. */
export async function openPayment(url: string, reference: string) {
  if (!isNativeApp) {
    window.location.assign(url);
    return;
  }
  pendingPayment = reference;
  await Browser.open({ url, presentationStyle: 'popover' });
}

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
