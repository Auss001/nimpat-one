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
