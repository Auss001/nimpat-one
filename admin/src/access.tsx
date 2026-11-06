import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { get } from './api';

/** A page or action is allowed by any of these permissions, optionally limited to one division. */
export interface Check {
  any: string[];
  division?: string | string[];
}

export interface Me {
  id: string;
  email: string;
  roles: { code: string; divisionId: string | null }[];
  permissions: Record<string, string[]>;
}
export interface Division {
  id: string;
  name: string;
  slug: string;
}

const GROUP_SCOPE = '*';

interface Access {
  me: Me | null;
  divisions: Division[];
  can: (check: Check) => boolean;
  /** Divisions in which the signed-in person holds this permission. */
  divisionsFor: (permission: string) => Division[];
}

const AccessCtx = createContext<Access>({ me: null, divisions: [], can: () => true, divisionsFor: () => [] });
export const useAccess = () => useContext(AccessCtx);

/**
 * Hides what someone cannot use. This is a convenience only: the API enforces
 * every permission whatever the dashboard shows.
 */
export function AccessProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [divisions, setDivisions] = useState<Division[]>([]);

  useEffect(() => {
    let alive = true;
    void get<Me>('/auth/me').then((m) => alive && setMe(m)).catch(() => undefined);
    void get<Division[]>('/divisions').then((d) => alive && setDivisions(d)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const can = useCallback(
    ({ any, division }: Check) => {
      // Until the profile loads, show everything rather than flash an empty menu.
      if (!me) return true;
      const slugs = division ? (Array.isArray(division) ? division : [division]) : [];
      const divisionIds = divisions.filter((d) => slugs.includes(d.slug)).map((d) => d.id);
      return any.some((p) => {
        const scopes = me.permissions[p];
        if (!scopes?.length) return false;
        if (!division || scopes.includes(GROUP_SCOPE)) return true;
        return divisionIds.some((id) => scopes.includes(id));
      });
    },
    [me, divisions],
  );

  const divisionsFor = useCallback(
    (permission: string) => {
      const scopes = me?.permissions[permission] ?? [];
      return scopes.includes(GROUP_SCOPE) ? divisions : divisions.filter((d) => scopes.includes(d.id));
    },
    [me, divisions],
  );

  return <AccessCtx.Provider value={{ me, divisions, can, divisionsFor }}>{children}</AccessCtx.Provider>;
}
