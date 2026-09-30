import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, LayoutGrid, LogOut, Medal, Radar } from 'lucide-react';
import { useSession } from './lib/session.jsx';
import { endpoints, setShareToken } from './lib/api.js';
import { Skeleton } from './components/ui.jsx';
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

// Top bar: the brand over the page's glow, and (on wider screens) navigation.
// On phones admin navigation is the floating tab bar, within thumb reach.
function TopBar() {
  const session = useSession();
  const signOut = useSignOut();
  const nav = ({ isActive }) => `hidden min-h-11 items-center sm:inline-flex gap-2 rounded-full px-4 text-sm font-bold transition ${isActive ? 'bg-brand text-brand-ink' : 'bg-white/6 text-ink/80 ring-1 ring-inset ring-white/10 hover:text-ink'}`;
  return (
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
          </nav>
        )}
      </div>
    </header>
  );
}

// Floating pill tab bar (phones, admin): the open section widens into a teal
// pill with its name; the others are round icon buttons.
function BottomTabs() {
  const session = useSession();
  const signOut = useSignOut();
  if (session.role !== 'admin') return null;
  const tab = ({ isActive }) => `flex h-13 items-center justify-center gap-2 rounded-full text-xs font-extrabold tracking-wide transition ${isActive ? 'bg-brand px-5 text-brand-ink' : 'w-13 bg-white/7 text-ink'}`;
  const label = (text) => ({ isActive }) => (isActive ? <span className="uppercase">{text}</span> : <span className="sr-only">{text}</span>);
  return (
    <nav aria-label="Main" className="float-safe fixed left-1/2 z-30 -translate-x-1/2 sm:hidden">
      <div className="flex items-center gap-1.5 rounded-full bg-[#122420]/95 p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10 backdrop-blur">
        <NavLink to="/" end className={tab}>{(s) => <><LayoutGrid size={20} aria-hidden="true" />{label('Groups')(s)}</>}</NavLink>
        <NavLink to="/leaderboards" className={tab}>{(s) => <><Medal size={20} aria-hidden="true" />{label('Boards')(s)}</>}</NavLink>
        <NavLink to="/status" className={tab}>{(s) => <><Activity size={20} aria-hidden="true" />{label('Status')(s)}</>}</NavLink>
        <button type="button" onClick={signOut} aria-label="Sign out" className="grid h-13 w-13 place-items-center rounded-full bg-white/7 text-ink"><LogOut size={20} aria-hidden="true" /></button>
      </div>
    </nav>
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
      <BottomTabs />
    </div>
  );
}
