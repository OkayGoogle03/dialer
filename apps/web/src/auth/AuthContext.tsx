import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, Me } from '../api/client';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (tenant: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

// Colours a tenant never customised are the old database defaults; those keep the built-in warm theme instead of overriding it.
const LEGACY_DEFAULT = new Set(['#2563eb', '#0f172a', '#16a34a']);
export function applyBranding(colors: { primary?: string; secondary?: string; accent?: string }) {
  const root = document.documentElement.style;
  const set = (name: string, v?: string) => { if (v && !LEGACY_DEFAULT.has(v.toLowerCase())) root.setProperty(name, v); else root.removeProperty(name); };
  set('--brand-primary', colors.primary);
  set('--brand-secondary', colors.secondary);
  set('--brand-accent', colors.accent);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const m = await api.get<Me>('/auth/me');
    setMe(m);
    if (m.branding) {
      applyBranding({ primary: m.branding.primaryColor, secondary: m.branding.secondaryColor, accent: m.branding.accentColor });
      document.title = m.branding.productName;
    }
  }, []);

  // Restore session from the refresh cookie on page load.
  useEffect(() => {
    api.onSessionExpired = () => setMe(null);
    (async () => {
      try {
        if (await api.refresh()) await loadMe();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMe]);

  const login = useCallback(async (tenant: string, email: string, password: string) => {
    const r = await api.post<{ accessToken: string }>('/auth/login', { tenant, email, password });
    api.setAccessToken(r.accessToken);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    api.setAccessToken(null);
    setMe(null);
  }, []);

  const value = useMemo<AuthState>(() => ({
    me, loading, login, logout,
    can: (p) => !!me?.permissions.includes(p),
  }), [me, loading, login, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
