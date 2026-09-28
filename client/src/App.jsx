import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './lib/session.jsx';
import { endpoints, setShareToken } from './lib/api.js';
import { Button, Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Share from './pages/Share.jsx';
import Home from './pages/Home.jsx';
import GroupNew from './pages/GroupNew.jsx';
import GroupLayout from './pages/GroupLayout.jsx';
import SnapshotTrace from './pages/SnapshotTrace.jsx';
import Status from './pages/Status.jsx';
import RunDetail from './pages/RunDetail.jsx';

function Header() {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    if (session.role === 'admin') await endpoints.logout().catch(() => {});
    setShareToken(null);
    qc.clear();
    navigate('/login');
  };
  const nav = ({ isActive }) => `rounded px-2 py-1 ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:text-slate-900'}`;
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Link to="/" className="text-lg font-semibold text-slate-900">FPL Radar</Link>
        {session.role !== 'anonymous' && (
          <nav className="flex items-center gap-1 text-sm">
            {session.role === 'admin' && <NavLink to="/" end className={nav}>Groups</NavLink>}
            {session.role === 'admin' && <NavLink to="/status" className={nav}>Status</NavLink>}
            {session.role === 'viewer' && <span className="px-2 text-slate-500">Viewer</span>}
            <Button variant="ghost" onClick={signOut}>{session.role === 'admin' ? 'Sign out' : 'Leave'}</Button>
          </nav>
        )}
      </div>
    </header>
  );
}

/** Admin-only routes; viewers go to their group, anonymous visitors to the login page. */
function RequireAdmin({ children }) {
  const s = useSession();
  if (s.loading) return <Spinner />;
  if (s.role === 'admin') return children;
  if (s.role === 'viewer') return <Navigate to={`/groups/${s.groupId}/results`} replace />;
  return <Navigate to="/login" replace />;
}

function RequireSignedIn({ children }) {
  const s = useSession();
  if (s.loading) return <Spinner />;
  return s.role === 'anonymous' ? <Navigate to="/login" replace /> : children;
}

export default function App() {
  const location = useLocation();
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-4 sm:py-6">
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
          <Route path="*" element={<p className="py-10 text-center text-slate-600">Page not found. <Link className="text-indigo-700 underline" to="/">Home</Link></p>} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
