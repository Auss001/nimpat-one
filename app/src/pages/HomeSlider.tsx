import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatNaira } from '../api';

/** The products featured on the home page, in order. Each is only shown if it has a picture and a price. */
const FEATURED: { match: RegExp; label: string; tone: string }[] = [
  { match: /^chamdor/i, label: 'Featured', tone: 'rose' },
  { match: /^swan 75/i, label: 'Bottled water', tone: 'sky' },
  { match: /^hennessy x\.?o/i, label: 'Top shelf', tone: 'gold' },
];

const AUTO_MS = 5000;
const REST_AFTER_TOUCH_MS = 9000;

/** Promos and featured items that slide by themselves and can be swiped. Prices come from the live catalogue. */
export function HomeSlider({ drinks, stays }: { drinks: any[]; stays: any[] }) {
  const featured = FEATURED.flatMap((f) => {
    const product = drinks.find((p) => f.match.test(p.name));
    return product ? [{ ...f, product }] : [];
  });
  const stay = stays.find((s) => s.image);
  const count = 1 + (stay ? 1 : 0) + featured.length;

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
    if (!el) return;
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

  return (
    <section className="slider" aria-label="Promos and featured items" onPointerDown={rest} onWheel={rest} onFocus={rest}>
      <span className="slider-glows" aria-hidden="true"><span className="slider-glow one" /><span className="slider-glow two" /></span>
      <div className="slider-track" ref={track} onScroll={onScroll}>
        <Link to="/shop/water-drinks-wines?category=water" className="slide flyer" aria-label="Drinks on promo. See water prices">
          <img src="/promo-drinks.webp" alt="" />
          <span className="slide-go flyer-go">See prices <ArrowRight size={15} aria-hidden="true" /></span>
        </Link>

        {stay && (
          <Link to="/apartments" className="slide photo-slide">
            <img src={stay.image} alt="" loading="lazy" />
            <span className="slide-text">
              <small>{stay.place}</small>
              <b>Luxury Apartments</b>
              <span className="slide-price">{formatNaira(stay.unit.nightlyRateMinor)} a night</span>
              <span className="slide-go">Book now <ArrowRight size={15} aria-hidden="true" /></span>
            </span>
          </Link>
        )}

        {featured.map(({ product: p, label, tone }) => (
          <Link key={p.id} to={`/product/${p.slug}`} className={`slide product-slide ${tone}`}>
            <span className="slide-text">
              <small>{label}{p.isAgeRestricted ? ' · 18+' : ''}</small>
              <b>{p.name}</b>
              <span className="slide-price">{formatNaira(p.priceFromMinor)}</span>
              <span className="slide-go">Shop now <ArrowRight size={15} aria-hidden="true" /></span>
            </span>
            <img src={p.images[0].url} alt="" loading="lazy" />
          </Link>
        ))}
      </div>
      {count > 1 && (
        <div className="slider-dots">
          {Array.from({ length: count }, (_, i) => (
            <button key={i} className={i === active ? 'on' : ''} aria-label={`Show slide ${i + 1} of ${count}`} aria-current={i === active} onClick={() => { rest(); goTo(i); }} />
          ))}
        </div>
      )}
    </section>
  );
}
