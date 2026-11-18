import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Only implemented screens are listed. Other modules appear as their phases land (see docs/PROJECT_STATUS.md).
const NAV: { to: string; label: string; perm?: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/users', label: 'Users', perm: 'users:read' },
  { to: '/dialer', label: 'Dialer', perm: 'calls:make' },
  { to: '/caller-import', label: 'Caller Excel Import', perm: 'caller_import:manage' },
  { to: '/processes', label: 'Processes', perm: 'master_data:read' },
  { to: '/providers', label: 'SIP Providers', perm: 'master_data:read' },
  { to: '/dids', label: 'DIDs', perm: 'master_data:read' },
  { to: '/call-servers', label: 'Call Servers', perm: 'master_data:read' },
  { to: '/teams', label: 'Teams', perm: 'users:read' },
  { to: '/roles', label: 'Roles', perm: 'roles:manage' },
  { to: '/settings/branding', label: 'Branding', perm: 'branding:manage' },
];

export function Shell() {
  const { me, logout, can } = useAuth();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">{me?.branding?.productName ?? 'Project Dialer'}</div>
        {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>{n.label}</NavLink>
        ))}
        {me?.isPlatformAdmin && <NavLink to="/platform/tenants">Platform · Tenants</NavLink>}
        <div className="spacer" />
        <button className="btn secondary" style={{ color: '#fff' }} onClick={logout}>Sign out</button>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
