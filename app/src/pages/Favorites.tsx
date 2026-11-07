import { Link } from 'react-router-dom';
import { formatNaira, get, rows } from '../api';
import { NeedsSignIn } from './Account';
import { ProductCard } from './Shop';
import { Empty, FavButton, Loader, Note, PageTitle, Photo, useLoad, useSession } from '../ui';

const PATH: Record<string, (slug: string) => string> = {
  PRODUCT: (s) => `/catalog/products/${s}`,
  PROPERTY: (s) => `/apartments/properties/${s.split('--')[0]}`,
  VEHICLE: (s) => `/vehicles/${s}`,
  TREATMENT: (s) => `/spa/treatments/${s}`,
};

export function FavoritesPage() {
  const session = useSession();
  const list = useLoad(async () => {
    if (!session) return [];
    const favourites = rows(await get('/me/favorites'));
    // Something no longer on sale simply drops off the list.
    const found = await Promise.all(favourites.map((f: any) => get(PATH[f.kind](f.itemSlug)).then((item) => ({ kind: f.kind, slug: f.itemSlug, item })).catch(() => null)));
    return found.filter(Boolean) as { kind: string; slug: string; item: any }[];
  }, [session?.email]);
  if (!session) return <NeedsSignIn title="Favourites" text="Save the things you love and find them here." next="/favorites" />;
  const data = list.data ?? [];
  const products = data.filter((f) => f.kind === 'PRODUCT');
  const others = data.filter((f) => f.kind !== 'PRODUCT');
  return (
    <>
      <PageTitle title="Favourites" back={false} />
      {list.loading && !list.data && <Loader />}
      {list.error && <Note tone="error">{list.error}</Note>}
      {list.data && data.length === 0 && <Empty title="Nothing saved yet" action={<Link className="btn primary" to="/">Start shopping</Link>}>Tap the heart on anything you like.</Empty>}
      {products.length > 0 && <div className="grid">{products.map((f) => <ProductCard key={f.slug} product={f.item} />)}</div>}
      {others.length > 0 && (
        <div className="grid wide">
          {others.map(({ kind, slug, item }) => {
            const [propertySlug, unitId] = slug.split('--');
            const flat = kind === 'PROPERTY' && unitId ? item.units?.find((u: any) => u.id === unitId) : null;
            const to = kind === 'PROPERTY' ? `/apartments/${propertySlug}${unitId ? `?unit=${unitId}` : ''}` : kind === 'VEHICLE' ? `/cars/${slug}` : `/spa/${slug}`;
            const name = flat?.name ?? (kind === 'VEHICLE' ? `${item.year} ${item.make} ${item.model}` : item.name);
            const image = kind === 'PROPERTY' ? (flat?.images?.[0]?.url ?? item.images?.[0]?.url) : kind === 'VEHICLE' ? item.images?.[0]?.url : item.imageUrl;
            return (
              <Link key={`${kind}-${slug}`} to={to} className="card stay">
                <FavButton kind={kind} slug={slug} />
                <div className="card-photo"><Photo src={image} alt={name} /></div>
                <div className="card-body">
                  <strong>{name}</strong>
                  {item.priceMinor != null && <span className="price">{formatNaira(item.priceMinor)}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
