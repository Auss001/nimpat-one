import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatNaira, get } from '../api';
import { useLoad } from '../ui';

interface Slide {
  id: string;
  kind: 'PICTURE' | 'PRODUCT' | 'APARTMENTS';
  title: string | null;
  subtitle: string | null;
  buttonText: string | null;
  imageUrl: string | null;
  linkTo: string | null;
  tone: string;
  product?: { name: string; slug: string; priceFromMinor: number; image: string; isAgeRestricted: boolean };
}

const AUTO_MS = 5000;
const REST_AFTER_TOUCH_MS = 9000;

function SlideLink({ to, className, label, children }: { to: string | null; className: string; label?: string; children: ReactNode }) {
  if (to?.startsWith('/')) return <Link to={to} className={className} aria-label={label}>{children}</Link>;
  if (to) return <a href={to} className={className} aria-label={label} target="_blank" rel="noreferrer">{children}</a>;
  return <div className={className} role="img" aria-label={label}>{children}</div>;
}

function Go({ text, className = '' }: { text: string; className?: string }) {
  return <span className={`slide-go ${className}`}>{text} <ArrowRight size={15} aria-hidden="true" /></span>;
}

/** Promos and featured items, managed under Home promos in the dashboard. Prices are always live. */
export function HomeSlider({ stays }: { stays: any[] }) {
  const loaded = useLoad(() => get<Slide[]>('/home-slides'), []);
  const stay = stays.find((s) => s.image);
  // Every card comes from Home promos in the dashboard, in its order there (owner, 14 November 2026).
  const slides = loaded.data ?? [];
  const count = slides.length;

  const track = useRef<HTMLDivElement>(null);
  const restUntil = useRef(0);
  const [active, setActive] = useState(0);
  const activeNow = useRef(0);
  activeNow.current = active;

  const goTo = (i: number) => {
    const el = track.current;
    const slide = el?.children[i] as HTMLElement | undefined;
    if (el && slide) el.scrollTo({ left: slide.offsetLeft - (el.children[0] as HTMLElement).offsetLeft, behavior: 'smooth' });
  };
  const rest = () => {
    restUntil.current = Date.now() + REST_AFTER_TOUCH_MS;
  };

  const onScroll = () => {
    const el = track.current;
    if (!el?.children.length) return;
    const left = el.scrollLeft;
    const first = (el.children[0] as HTMLElement).offsetLeft;
    let nearest = 0;
    let gap = Infinity;
    Array.from(el.children).forEach((c, i) => {
      const d = Math.abs((c as HTMLElement).offsetLeft - first - left);
      if (d < gap) {
        gap = d;
        nearest = i;
      }
    });
    // At the very end the last slides cannot reach the start edge, so the last dot still lights up.
    if (left + el.clientWidth >= el.scrollWidth - 4) nearest = count - 1;
    setActive(nearest);
  };

  useEffect(() => {
    if (count < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => {
      if (document.hidden || Date.now() < restUntil.current) return;
      goTo((activeNow.current + 1) % count);
    }, AUTO_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  if (loaded.loading && !loaded.data) return <div className="slide slide-wait" aria-hidden="true" />;
  if (count === 0) return null;

  return (
    <section className="slider" aria-label="Promos and featured items" onPointerDown={rest} onWheel={rest} onFocus={rest}>
      <span className="slider-glows" aria-hidden="true"><span className="slider-glow one" /><span className="slider-glow two" /></span>
      <div className="slider-track" ref={track} onScroll={onScroll}>
        {slides.map((s) => {
          if (s.kind === 'PRODUCT' && s.product) {
            const p = s.product;
            const label = [s.subtitle, p.isAgeRestricted ? '18+' : null].filter(Boolean).join(' · ');
            return (
              <Link key={s.id} to={`/product/${p.slug}`} className={`slide product-slide ${s.tone}`}>
                <span className="slide-text">
                  {label && <small>{label}</small>}
                  <b>{p.name}</b>
                  <span className="slide-price">{formatNaira(p.priceFromMinor)}</span>
                  <Go text="Shop now" />
                </span>
                <img src={p.image} alt="" loading="lazy" />
              </Link>
            );
          }
          if (s.kind === 'APARTMENTS') {
            return (
              <Link key={s.id} to="/apartments" className="slide flyer apartments-slide" aria-label={`Luxury Apartments: stay beautifully, feel at home.${stay ? ` From ${formatNaira(stay.unit.nightlyRateMinor)} a night.` : ''} Explore stays`}>
                <img src={s.imageUrl ?? stay?.image ?? ''} alt="" loading="lazy" />
              </Link>
            );
          }
          if (s.title) {
            return (
              <SlideLink key={s.id} to={s.linkTo} className="slide photo-slide">
                <img src={s.imageUrl ?? ''} alt="" loading="lazy" />
                <span className="slide-text">
                  {s.subtitle && <small>{s.subtitle}</small>}
                  <b>{s.title}</b>
                  {s.buttonText && <Go text={s.buttonText} />}
                </span>
              </SlideLink>
            );
          }
          return (
            <SlideLink key={s.id} to={s.linkTo} className="slide flyer" label={s.subtitle ?? s.buttonText ?? 'Promotion'}>
              <img src={s.imageUrl ?? ''} alt="" />
              {s.buttonText && <Go text={s.buttonText} className="flyer-go" />}
            </SlideLink>
          );
        })}
      </div>
      {count > 1 && (
        <div className="slider-dots">
          {slides.map((s, i) => (
            <button key={s.id} className={i === active ? 'on' : ''} aria-label={`Show slide ${i + 1} of ${count}`} aria-current={i === active} onClick={() => { rest(); goTo(i); }} />
          ))}
        </div>
      )}
    </section>
  );
}
