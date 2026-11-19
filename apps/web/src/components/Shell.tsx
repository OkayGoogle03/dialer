import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bell, Building2, Download, Headphones, LayoutDashboard, ListChecks, LogOut, Palette, Search, Server, ShieldCheck, Users, UsersRound } from 'lucide-react';
import { Button } from '@dialer/ui';
import { useAuth } from '../auth/AuthContext';

// Only implemented screens are listed. Other modules appear as their phases land (see docs/PROJECT_STATUS.md).
interface NavItem { to: string; label: string; icon: ReactNode; perm?: string; end?: boolean }
const ICON = 20;
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={ICON} />, end: true },
  { to: '/softphone', label: 'Softphone', icon: <Headphones size={ICON} />, perm: 'calls:make' },
  { to: '/call-lists', label: 'Call Lists', icon: <ListChecks size={ICON} />, perm: 'caller_import:manage' },
  { to: '/call-servers', label: 'Call Servers', icon: <Server size={ICON} />, perm: 'master_data:read' },
  { to: '/users', label: 'Users', icon: <Users size={ICON} />, perm: 'users:read' },
  { to: '/teams', label: 'Teams', icon: <UsersRound size={ICON} />, perm: 'users:read' },
  { to: '/roles', label: 'Roles', icon: <ShieldCheck size={ICON} />, perm: 'roles:manage' },
  { to: '/download', label: 'Download App', icon: <Download size={ICON} /> },
  { to: '/settings/branding', label: 'Branding', icon: <Palette size={ICON} />, perm: 'branding:manage' },
];
const PLATFORM_NAV: NavItem[] = [
  { to: '/platform', label: 'Overview', icon: <LayoutDashboard size={ICON} />, end: true },
  { to: '/platform/tenants', label: 'Tenants', icon: <Building2 size={ICON} /> },
];

/** Jump-to-screen command bar (Ctrl/Cmd+K). */
function CommandBar({ items }: { items: NavItem[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const found = useMemo(() => items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())), [items, q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const go = (to: string) => { nav(to); setQ(''); setOpen(false); ref.current?.blur(); };
  return (
    <div className="cmd" role="search">
      <Search className="ico" size={16} aria-hidden />
      <input ref={ref} type="search" placeholder="Jump to a screen…" aria-label="Jump to a screen" value={q} autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setIdx(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, found.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && found[idx]) go(found[idx].to);
          else if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
        }} />
      <kbd>Ctrl K</kbd>
      {open && q.trim() !== '' && (
        <ul className="cmd-list">
          {found.length === 0 ? <li className="hint" style={{ padding: 10 }}>No screen matches.</li> : found.map((i, n) => (
            <li key={i.to}><button type="button" className={n === idx ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); go(i.to); }}>{i.icon}{i.label}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Shell() {
  const { me, logout, can } = useAuth();
  const platform = !!me?.isPlatformAdmin;
  const loc = useLocation();
  const [menu, setMenu] = useState<'bell' | 'profile' | null>(null);
  const items = platform ? PLATFORM_NAV : NAV.filter((n) => !n.perm || can(n.perm));
  const name = me?.user.displayName ?? '';
  const product = platform ? 'Platform Console' : me?.branding?.productName ?? 'Project Dialer';
  useEffect(() => setMenu(null), [loc.pathname]);
  return (
    <div className="shell">
      <header className="topnav">
        <div className="avatar" aria-hidden>{(name || product).trim().charAt(0).toUpperCase()}</div>
        <div className="welcome"><b>Welcome{name ? `, ${name}` : ''}</b><span>{product}{me && !platform ? ` · ${me.tenant.name}` : ''}</span></div>
        <CommandBar items={items} />
        <div className="top-actions">
          <button className="icon-btn" aria-label="Notifications" aria-expanded={menu === 'bell'} onClick={() => setMenu(menu === 'bell' ? null : 'bell')}><Bell size={18} /></button>
          <button className="icon-btn" aria-label="Account menu" aria-expanded={menu === 'profile'} onClick={() => setMenu(menu === 'profile' ? null : 'profile')}>{(name || 'U').charAt(0).toUpperCase()}</button>
          {menu === 'bell' && <div className="pop" role="status"><span className="hint">No new notifications.</span></div>}
          {menu === 'profile' && (
            <div className="pop">
              <b style={{ padding: '4px 8px', display: 'block' }}>{name}</b>
              <span className="hint">{me?.user.email}</span>
              <Button variant="secondary" onClick={logout}><LogOut size={16} /> Sign out</Button>
            </div>
          )}
        </div>
      </header>
      <nav className="rail" aria-label="Main">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} aria-label={n.label}>{n.icon}<span className="lbl" aria-hidden>{n.label}</span></NavLink>
        ))}
      </nav>
      <main className="main">
        <motion.div key={loc.pathname} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
          <Outlet />
        </motion.div>
      </main>
      <nav className="dock" aria-label="Main (mobile)">
        {items.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.icon}{n.label}</NavLink>)}
      </nav>
    </div>
  );
}
