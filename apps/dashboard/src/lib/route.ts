// Hash routing: #/agents?agent=2, #/activity?status=rejected&agent=6. Mock scenario params stay in the page query.
import { useEffect, useState } from 'react';

export type Screen = 'agents' | 'activity';
export interface Route {
  screen: Screen;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = h.split('?');
  return { screen: path === 'activity' ? 'activity' : 'agents', params: new URLSearchParams(query) };
}

export function hrefFor(screen: Screen, params?: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '') q.set(k, String(v));
  const qs = q.toString();
  return '#/' + screen + (qs ? '?' + qs : '');
}

/** Replace the hash without a history entry (filters, panel open and close). */
export function replaceRoute(screen: Screen, params?: Record<string, string | number | null | undefined>): void {
  const url = window.location.pathname + window.location.search + hrefFor(screen, params);
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
