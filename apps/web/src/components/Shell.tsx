import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Only implemented screens are listed. Other modules appear as their phases land (see docs/PROJECT_STATUS.md).
const NAV: { to: string; label: string; perm?: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/users', label: 'Users', perm: 'users:read' },
  { to: '/softphone', label: 'Softphone', perm: 'calls:make' },
  { to: '/caller-import', label: 'Caller Excel Import', perm: 'caller_import:manage' },
  { to: '/processes', label: 'Processes', perm: 'master_data:read' },
  { to: '/providers', label: 'SIP Providers', perm: 'master_data:read' },
  { to: '/dids', label: 'DIDs', perm: 'master_data:read' },
  { to: '/call-servers', label: 'Call Servers', perm: 'master_data:read' },
  { to: '/teams', label: 'Teams', perm: 'users:read' },
  { to: '/roles', label: 'Roles', perm: 'roles:manage' },
  { to: '/settings/branding', label: 'Branding', perm: 'branding:manage' },
];

const PLATFORM_NAV = [{ to: '/platform', label: 'Overview', end: true }, { to: '/platform/tenants', label: 'Tenants', end: false }];

export function Shell() {
  const { me, logout, can } = useAuth();
  const platform = !!me?.isPlatformAdmin;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">{platform ? 'Platform Console' : me?.branding?.productName ?? 'Project Dialer'}</div>
        {platform
          ? PLATFORM_NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)
          : NAV.filter((n) => !n.perm || can(n.perm)).map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/'}>{n.label}</NavLink>)}
        <div className="spacer" />
        <button className="btn secondary" style={{ color: '#fff' }} onClick={logout}>Sign out</button>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
