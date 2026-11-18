import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, Branding } from '../api/client';
import { applyBranding, useAuth } from '../auth/AuthContext';

const TENANT_KEY = 'dialer.lastTenant';

function readStoredTenant(): string {
  try { return localStorage.getItem(TENANT_KEY) ?? ''; } catch { return ''; }
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tenant, setTenant] = useState(params.get('tenant') ?? readStoredTenant());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState<(Branding & { tenantName: string }) | null>(null);

  // White-label: fetch the tenant's public branding once a valid slug is entered.
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(tenant)) { setBranding(null); return; }
    const t = setTimeout(() => {
      api.get<Branding & { tenantName: string }>(`/public/branding?tenant=${encodeURIComponent(tenant)}`)
        .then((b) => { setBranding(b); applyBranding({ primary: b.primaryColor, secondary: b.secondaryColor, accent: b.accentColor }); })
        .catch(() => setBranding(null));
    }, 300);
    return () => clearTimeout(t);
  }, [tenant]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(tenant, email, password);
      try { localStorage.setItem(TENANT_KEY, tenant); } catch { /* storage unavailable */ }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Please wait a minute.' : err instanceof ApiError ? err.message : 'Unable to reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={onSubmit} noValidate>
        {branding?.logoUrl && <img className="logo" src={branding.logoUrl} alt={`${branding.tenantName} logo`} />}
        <h1>{branding ? `Sign in to ${branding.productName}` : 'Sign in'}</h1>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="tenant">Company ID</label>
          <input id="tenant" value={tenant} onChange={(e) => setTenant(e.target.value.trim().toLowerCase())} autoComplete="organization" required />
          {branding && <span className="hint">{branding.tenantName}</span>}
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy || !tenant || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint" style={{ marginTop: 16 }}><Link to="/forgot-password">Forgot password?</Link></p>
      </form>
    </div>
  );
}
