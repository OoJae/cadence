import { lazy, Suspense } from 'react';
import { Shell } from './components/Layout';
import { matchPath, useLocation } from './router';
import { Landing } from './pages/Landing';
import { Merchant } from './pages/Merchant';
import { Subscribe } from './pages/Subscribe';
import { Decode } from './pages/Decode';
import { Sandbox } from './pages/Sandbox';
import { Manage } from './pages/Manage';
import { Status } from './pages/Status';
import { NotFound } from './pages/NotFound';

// The brand book is a page for people looking at the design, not for paying: load it on demand.
const Brand = lazy(() => import('./pages/Brand').then((m) => ({ default: m.Brand })));

function Routes() {
  const { pathname } = useLocation();
  if (pathname === '/') return <Landing />;
  if (pathname === '/merchant') return <Merchant />;
  if (pathname === '/subscribe') return <Subscribe />;
  if (pathname === '/sandbox') return <Sandbox />;
  if (pathname === '/manage') return <Manage />;
  if (pathname === '/status') return <Status />;
  if (pathname === '/brand')
    return (
      <Suspense fallback={null}>
        <Brand />
      </Suspense>
    );
  if (pathname === '/decode') return <Decode txid={null} />;
  const decode = matchPath('/decode/:txid', pathname);
  if (decode) return <Decode key={decode.txid} txid={decode.txid ?? null} />;
  return <NotFound />;
}

export function App() {
  return (
    <Shell>
      <Routes />
    </Shell>
  );
}
