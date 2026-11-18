import { useAuth } from '../auth/AuthContext';

export function DashboardPage() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <>
      <div className="topbar">
        <h1>Welcome, {me.user.displayName}</h1>
      </div>
      <div className="grid">
        <div className="card">
          <h2>Company</h2>
          <div>{me.tenant.name}</div>
          <div className="hint">ID: {me.tenant.slug}</div>
        </div>
        <div className="card">
          <h2>Your roles</h2>
          {me.roles.map((r) => <span key={r} className="badge">{r.replace('_', ' ')}</span>)}
        </div>
        <div className="card">
          <h2>Telephony</h2>
          <p className="hint">Calling, softphone and live statistics arrive with Phase 2–4.</p>
        </div>
      </div>
    </>
  );
}
