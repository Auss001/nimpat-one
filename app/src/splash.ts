/** Fades out the opening screen from index.html once the app has drawn, after at least a short moment so it never just flickers. */
const MIN_SHOWN_MS = 1400;

export function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  const started = (window as unknown as { __splashStarted?: number }).__splashStarted ?? Date.now();
  const wait = Math.max(0, MIN_SHOWN_MS - (Date.now() - started));
  window.setTimeout(() => {
    el.classList.add('leaving');
    window.setTimeout(() => {
      clearInterval((window as unknown as { __splashTimer?: number }).__splashTimer);
      el.remove();
    }, 400);
  }, wait);
}
