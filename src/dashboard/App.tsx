import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, type Me } from './lib/api';
import { BRAND } from './lib/brand';
import { Billing } from './pages/Billing';
import { Dashboard } from './pages/Dashboard';
import { LivePage } from './pages/Live';
import { Login } from './pages/Login';
import { PublicEntry } from './pages/Public';
import { Settings } from './pages/Settings';
import { Sites } from './pages/Sites';

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  // A replaced entry keeps its state, so a page opened from a bookmark still knows there is no in-app page behind it.
  if (replace) window.history.replaceState(window.history.state, '', to);
  else window.history.pushState({ app: true }, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

const SITE = window.location.origin;
const HOME_TITLE = BRAND;
const HOME_DESCRIPTION = `${BRAND}: visitors, sources and revenue for your websites.`;
/** The owner's sign-in page. Nothing links to it: the owner types it in. */
export const ADMIN_LOGIN = '/admin-login';
const APP_PAGE = /^\/(admin-login|billing(\/.*)?|site\/[\w-]+(\/settings|\/live|\/search)?\/?)$/;
const LIVE_PAGE = /^\/site\/([\w-]+)\/live\/?$/;

function setTag(selector: string, create: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}
const meta = (name: string) => () => Object.assign(document.createElement('meta'), { name });

// A private dashboard: every page keeps the same title and stays out of search results.
function usePageMeta(path: string) {
  useEffect(() => {
    document.title = HOME_TITLE;
    setTag('meta[name="description"]', meta('description'), 'content', HOME_DESCRIPTION);
    setTag('meta[name="robots"]', meta('robots'), 'content', 'noindex');
    setTag('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), 'href', SITE + '/');
  }, [path]);
}

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <p className="num text-6xl font-semibold text-stone-300">404</p>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">There's nothing here</h1>
      <p className="mt-1 text-sm text-stone-500">The page may have moved, or it was never shared.</p>
      <button className="btn mt-6" onClick={() => navigate('/')}>
        Go to the websites
      </button>
    </div>
  );
}

const MeContext = createContext<{ me: Me; refresh: () => Promise<Me> } | null>(null);
export function useMe() {
  const m = useContext(MeContext);
  if (!m) throw new Error('useMe outside App');
  return m;
}

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  usePageMeta(path);

  const refresh = useCallback(async () => {
    const r = await api<Me>('/api/auth/me').catch(() => ({ loggedIn: false, hosted: false, user: null }) as Me);
    setMe(r);
    return r;
  }, []);

  useEffect(() => {
    refresh();
    const out = () => setMe((m) => (m ? { ...m, loggedIn: false, user: null } : m));
    window.addEventListener('ml:logout', out);
    return () => window.removeEventListener('ml:logout', out);
  }, [refresh]);

  // Tell the tracker (when this dashboard tracks itself) who is signed in, and record brand-new signups.
  const userId = me?.user?.id;
  useEffect(() => {
    if (!me?.user || me.user.id === 'admin') return;
    window.openAnalytics?.('identify', { user_id: me.user.id, email: me.user.email, name: me.user.name });
    const q = new URLSearchParams(window.location.search);
    if (q.get('signup') === '1') {
      window.openAnalytics?.('goal', 'signup_completed');
      q.delete('signup');
      window.history.replaceState(window.history.state, '', window.location.pathname + (q.toString() ? `?${q}` : ''));
    }
    // Only when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Already signed in: the sign-in page has nothing to show, go to the websites list.
  useEffect(() => {
    if (me?.loggedIn && path === ADMIN_LOGIN) navigate('/', { replace: true });
  }, [me?.loggedIn, path]);

  const onLogin = useCallback(async () => {
    await refresh();
    if (window.location.pathname === ADMIN_LOGIN) navigate('/', { replace: true });
  }, [refresh]);

  if (!me) return null;

  if (path !== '/' && !APP_PAGE.test(path)) return <NotFound />;

  let page;
  if (!me.loggedIn) {
    // Logged out: the public, read-only view of the owner's public sites. The sign-in form exists only at
    // ADMIN_LOGIN; settings, billing and private sites look like any missing page, so nothing hints at it.
    const publicSite = /^\/site\/([\w-]+)\/?$/.exec(path);
    const publicLive = LIVE_PAGE.exec(path);
    if (path === ADMIN_LOGIN) page = <Login onLogin={onLogin} />;
    else if (publicLive) page = <LivePage key={path} siteId={publicLive[1]} readOnly />;
    else if (path === '/' || publicSite) page = <PublicEntry key={path} siteId={publicSite?.[1]} />;
    else page = <NotFound />;
  } else if (me.hosted && !me.user?.paid) {
    // Signed in but hasn't paid yet: the only thing to do is pick the plan.
    page = <Billing />;
  } else if (path.startsWith('/billing')) {
    page = <Billing />;
  } else {
    const settings = /^\/site\/([\w-]+)\/settings\/?$/.exec(path);
    const live = LIVE_PAGE.exec(path);
    const site = /^\/site\/([\w-]+)\/?$/.exec(path);
    const search = /^\/site\/([\w-]+)\/search\/?$/.exec(path);
    // The dashboard stays mounted while its settings panel opens and closes over it, and between its tabs.
    const dashboardId = settings?.[1] ?? site?.[1] ?? search?.[1];
    page = live ? (
      <LivePage key={path} siteId={live[1]} readOnly={false} />
    ) : dashboardId ? (
      <>
        <Dashboard key={dashboardId} siteId={dashboardId} view={search ? 'search' : 'overview'} />
        {settings && <Settings siteId={dashboardId} />}
      </>
    ) : (
      <Sites />
    );
  }
  return <MeContext.Provider value={{ me, refresh }}>{page}</MeContext.Provider>;
}
