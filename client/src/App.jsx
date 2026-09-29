import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, LayoutGrid, LogOut, Radar } from 'lucide-react';
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

// Top bar: brand + (on wider screens) navigation. On phones navigation moves
// to the bottom tab bar, within thumb reach.
function TopBar() {
  const session = useSession();
  const signOut = useSignOut();
  const nav = ({ isActive }) => `hidden min-h-10 items-center sm:inline-flex gap-2 rounded-xl px-3 text-sm font-semibold transition ${isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:text-white'}`;
  return (
    <header className="sticky top-0 z-30 bg-gradient-to-r from-[#2e1065] via-[#4c1d95] to-[#6d28d9] text-white shadow-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
        <Link to="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-white/15"><Radar size={18} aria-hidden="true" /></span>
          FPL Radar
        </Link>
        {session.role !== 'anonymous' && (
          <nav className="flex items-center gap-1">
            {session.role === 'admin' && <NavLink to="/" end className={nav}><LayoutGrid size={16} />Groups</NavLink>}
            {session.role === 'admin' && <NavLink to="/status" className={nav}><Activity size={16} />Status</NavLink>}
            {session.role === 'viewer' && <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">Viewer</span>}
            <button type="button" onClick={signOut} className="hidden min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-white/75 hover:text-white sm:inline-flex">
              <LogOut size={16} />{session.role === 'admin' ? 'Sign out' : 'Leave'}
            </button>
            {session.role === 'viewer' && (
              <button type="button" onClick={signOut} aria-label="Leave" className="grid h-10 w-10 place-items-center rounded-xl text-white/80 sm:hidden"><LogOut size={18} /></button>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}

function BottomTabs() {
  const session = useSession();
  const signOut = useSignOut();
  if (session.role !== 'admin') return null;
  const tab = ({ isActive }) => `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${isActive ? 'text-brand dark:text-violet-300' : 'text-muted'}`;
  return (
    <nav aria-label="Main" className="bottom-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur sm:hidden">
      <div className="mx-auto flex max-w-md">
        <NavLink to="/" end className={tab}><LayoutGrid size={22} />Groups</NavLink>
        <NavLink to="/status" className={tab}><Activity size={22} />Status</NavLink>
        <button type="button" onClick={signOut} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold text-muted"><LogOut size={22} />Sign out</button>
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
    <div className="min-h-dvh bg-bg font-sans text-ink antialiased">
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
