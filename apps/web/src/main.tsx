import { StrictMode, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Shell } from './components/Shell';
import { BrandingPage } from './pages/BrandingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { RolesPage } from './pages/RolesPage';
import { TeamsPage } from './pages/TeamsPage';
import { PlatformTenantsPage } from './pages/PlatformTenantsPage';
import { PlatformOverviewPage } from './pages/PlatformOverviewPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { DidsPage } from './pages/DidsPage';
import { ProcessesPage } from './pages/ProcessesPage';
import { CallServersPage } from './pages/CallServersPage';
import { CallerImportPage } from './pages/CallerImportPage';
import { SoftphonePage } from './pages/SoftphonePage';
import '@dialer/ui/styles.css';

function RequireAuth({ children, perm }: { children: ReactNode; perm?: string }) {
  const { me, loading, can } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (perm && !can(perm)) return <div className="error" role="alert">You do not have access to this page.</div>;
  return <>{children}</>;
}

/** Layout route for every tenant screen: a platform super admin has no tenant, so they are sent to the platform console. */
function TenantOnly() {
  const { me } = useAuth();
  return me?.isPlatformAdmin ? <Navigate to="/platform" replace /> : <Outlet />;
}

function RequirePlatform({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  return me?.isPlatformAdmin ? <>{children}</> : <div className="error" role="alert">Platform administrator access required.</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route element={<RequireAuth><Shell /></RequireAuth>}>
            <Route path="platform" element={<RequirePlatform><PlatformOverviewPage /></RequirePlatform>} />
            <Route path="platform/tenants" element={<RequirePlatform><PlatformTenantsPage /></RequirePlatform>} />
            <Route element={<TenantOnly />}>
            <Route index element={<DashboardPage />} />
            <Route path="users" element={<RequireAuth perm="users:read"><UsersPage /></RequireAuth>} />
            <Route path="teams" element={<RequireAuth perm="users:read"><TeamsPage /></RequireAuth>} />
            <Route path="roles" element={<RequireAuth perm="roles:manage"><RolesPage /></RequireAuth>} />
            <Route path="providers" element={<RequireAuth perm="master_data:read"><ProvidersPage /></RequireAuth>} />
            <Route path="dids" element={<RequireAuth perm="master_data:read"><DidsPage /></RequireAuth>} />
            <Route path="processes" element={<RequireAuth perm="master_data:read"><ProcessesPage /></RequireAuth>} />
            <Route path="call-servers" element={<RequireAuth perm="master_data:read"><CallServersPage /></RequireAuth>} />
            <Route path="caller-import" element={<RequireAuth perm="caller_import:manage"><CallerImportPage /></RequireAuth>} />
            <Route path="softphone" element={<RequireAuth perm="calls:make"><SoftphonePage /></RequireAuth>} />
            <Route path="dialer" element={<Navigate to="/softphone" replace />} />
            <Route path="settings/branding" element={<RequireAuth perm="branding:manage"><BrandingPage /></RequireAuth>} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
