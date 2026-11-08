import type { CapacitorConfig } from '@capacitor/cli';

/** Nimpat One as an Android and iPhone app: the same React app, bundled inside, talking to the live API. */
const config: CapacitorConfig = {
  appId: 'com.nimpatgroup.one',
  appName: 'Nimpat One',
  webDir: 'dist',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' },
  plugins: {
    SplashScreen: { launchShowDuration: 900, backgroundColor: '#eef3ee', showSpinner: false },
  },
};

export default config;
