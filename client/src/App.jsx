import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Activity, EllipsisVertical, LayoutGrid, LogOut, Medal, Radar } from 'lucide-react';
import { useSession } from './lib/session.jsx';
import { endpoints, setShareToken } from './lib/api.js';
import { Drawer, Skeleton } from './components/ui.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import Login from './pages/Login.jsx';
import Share from './pages/Share.jsx';
import Home from './pages/Home.jsx';
import GroupNew from './pages/GroupNew.jsx';
import GroupLayout from './pages/GroupLayout.jsx';
import SnapshotTrace from './pages/SnapshotTrace.jsx';
import Status from './pages/Status.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Leaderboards from './pages/Leaderboards.jsx';

function useSignOut() {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    if (session.role === 'admin') await endpoints.logout().catch(() => {});
    setShareToken(null);
    qc.clear();
    navigate('/login');
  };
}

// Top bar: the brand over the page's glow. On wider screens admin navigation
// sits here as pills; on phones it moves into the ⋮ menu (a bottom sheet), and
// the floating tab bar inside a group is the group's own navigation.
function TopBar() {
  const session = useSession();
  const signOut = useSignOut();
  const [menu, setMenu] = useState(false);
  const nav = ({ isActive }) => `hidden min-h-11 items-center sm:inline-flex gap-2 rounded-full px-4 text-sm font-bold transition ${isActive ? 'bg-brand text-brand-ink' : 'bg-white/6 text-ink/80 ring-1 ring-inset ring-white/10 hover:text-ink'}`;
  const item = ({ isActive }) => `flex min-h-13 items-center gap-3 rounded-2xl px-4 font-bold ${isActive ? 'bg-brand text-brand-ink' : 'bg-white/5 text-ink ring-1 ring-inset ring-white/8'}`;
  // The sheet renders outside <header>: its backdrop-filter would trap a fixed child.
  return (
    <>
    <header className="sticky top-0 z-30 bg-[#082520]/35 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4">
        <Link to="/" className="flex items-center gap-2.5 font-display text-2xl font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-[#1b8f78] text-brand-ink"><Radar size={20} aria-hidden="true" /></span>
          FPL Radar
        </Link>
        {session.role !== 'anonymous' && (
          <nav className="flex items-center gap-2">
            {session.role === 'admin' && <NavLink to="/" end className={nav}><LayoutGrid size={16} />Groups</NavLink>}
            {session.role === 'admin' && <NavLink to="/leaderboards" className={nav}><Medal size={16} />Boards</NavLink>}
            {session.role === 'admin' && <NavLink to="/status" className={nav}><Activity size={16} />Status</NavLink>}
            {session.role === 'viewer' && <span className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-bold ring-1 ring-white/10">Viewer</span>}
            <button type="button" onClick={signOut} className="hidden min-h-11 items-center gap-2 rounded-full bg-white/6 px-4 text-sm font-bold text-ink/80 ring-1 ring-inset ring-white/10 hover:text-ink sm:inline-flex">
              <LogOut size={16} />{session.role === 'admin' ? 'Sign out' : 'Leave'}
            </button>
            {session.role === 'viewer' && (
              <button type="button" onClick={signOut} aria-label="Leave" className="grid h-11 w-11 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 sm:hidden"><LogOut size={18} /></button>
            )}
            {session.role === 'admin' && (
              <button type="button" onClick={() => setMenu(true)} aria-label="Menu" data-testid="menu" className="grid h-12 w-12 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 sm:hidden"><EllipsisVertical size={20} /></button>
            )}
          </nav>
        )}
      </div>
    </header>
      <Drawer open={menu} title="Menu" onClose={() => setMenu(false)} testId="menu-sheet">
        <div className="space-y-2">
          <NavLink to="/" end className={item} onClick={() => setMenu(false)}><LayoutGrid size={20} aria-hidden="true" />Groups</NavLink>
          <NavLink to="/leaderboards" className={item} onClick={() => setMenu(false)}><Medal size={20} aria-hidden="true" />Boards</NavLink>
          <NavLink to="/status" className={item} onClick={() => setMenu(false)}><Activity size={20} aria-hidden="true" />Status</NavLink>
          <button type="button" onClick={() => { setMenu(false); signOut(); }} className="flex min-h-13 w-full items-center gap-3 rounded-2xl bg-white/5 px-4 font-bold text-ink ring-1 ring-inset ring-white/8"><LogOut size={20} aria-hidden="true" />Sign out</button>
        </div>
      </Drawer>
    </>
  );
}

/** Admin-only routes; viewers go to their group, anonymous visitors to the login page. */
function RequireAdmin({ children }) {
  const s = useSession();
  if (s.loading) return <Skeleton />;
  if (s.role === 'admin') return children;
  if (s.role === 'viewer') return <Navigate to={`/groups/${s.groupId}/results`} replace />;
  return <Navigate to="/login" replace />;
}

function RequireSignedIn({ children }) {
  const s = useSession();
  if (s.loading) return <Skeleton />;
  return s.role === 'anonymous' ? <Navigate to="/login" replace /> : children;
}

export default function App() {
  const location = useLocation();
  return (
    <div className="min-h-dvh font-sans text-ink antialiased">
      <TopBar />
      <main className="pb-safe mx-auto max-w-5xl px-4 pt-4 sm:pt-6">
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/share" element={<Share />} />
            <Route path="/" element={<RequireAdmin><Home /></RequireAdmin>} />
            <Route path="/groups/new" element={<RequireAdmin><GroupNew /></RequireAdmin>} />
            <Route path="/groups/:groupId" element={<Navigate to="results" replace />} />
            <Route path="/groups/:groupId/:tab" element={<RequireSignedIn><GroupLayout /></RequireSignedIn>} />
            <Route path="/snapshots/:snapshotId" element={<RequireSignedIn><SnapshotTrace /></RequireSignedIn>} />
            <Route path="/leaderboards" element={<RequireAdmin><Leaderboards /></RequireAdmin>} />
            <Route path="/status" element={<RequireAdmin><Status /></RequireAdmin>} />
            <Route path="/status/runs/:runId" element={<RequireAdmin><RunDetail /></RequireAdmin>} />
            <Route path="*" element={<p className="py-10 text-center text-muted">Page not found. <Link className="font-semibold text-brand underline" to="/">Home</Link></p>} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
