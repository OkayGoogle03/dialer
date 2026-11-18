import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, Branding } from '../api/client';
import { applyBranding } from '../auth/AuthContext';

export function BrandingPage() {
  const [b, setB] = useState<Branding | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Branding>('/branding').then(setB).catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to load' }));
  }, []);

  if (!b) return msg ? <div className="error">{msg.text}</div> : <div className="empty">Loading…</div>;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api.put<Branding>('/branding', {
        productName: b!.productName,
        primaryColor: b!.primaryColor,
        secondaryColor: b!.secondaryColor,
        accentColor: b!.accentColor,
        ...(b!.logoUrl ? { logoUrl: b!.logoUrl } : {}),
        ...(b!.supportEmail ? { supportEmail: b!.supportEmail } : {}),
      });
      setB(saved);
      applyBranding({ primary: saved.primaryColor, secondary: saved.secondaryColor, accent: saved.accentColor });
      setMsg({ ok: true, text: 'Branding saved' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? [err.message, ...((err.details as string[]) ?? [])].join(' — ') : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  const color = (key: 'primaryColor' | 'secondaryColor' | 'accentColor', label: string) => (
    <div className="field">
      <label htmlFor={key}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="color" aria-label={`${label} picker`} value={b[key]} onChange={(e) => setB({ ...b, [key]: e.target.value })} />
        <input id={key} value={b[key]} onChange={(e) => setB({ ...b, [key]: e.target.value })} pattern="#[0-9a-fA-F]{6}" />
      </div>
    </div>
  );

  return (
    <>
      <h1>Branding</h1>
      <form className="card" style={{ maxWidth: 520 }} onSubmit={save}>
        {msg && <div className={msg.ok ? 'success' : 'error'} role="status">{msg.text}</div>}
        <div className="field"><label htmlFor="pn">Product name</label><input id="pn" value={b.productName} onChange={(e) => setB({ ...b, productName: e.target.value })} /></div>
        <div className="field">
          <label htmlFor="logo">Logo URL</label>
          <input id="logo" value={b.logoUrl ?? ''} onChange={(e) => setB({ ...b, logoUrl: e.target.value || null })} placeholder="https://…" />
          <span className="hint">HTTPS only. Direct logo upload to object storage arrives with S3 integration (Phase 2).</span>
        </div>
        {color('primaryColor', 'Primary colour')}
        {color('secondaryColor', 'Sidebar colour')}
        {color('accentColor', 'Accent colour')}
        <div className="field"><label htmlFor="se">Support email</label><input id="se" type="email" value={b.supportEmail ?? ''} onChange={(e) => setB({ ...b, supportEmail: e.target.value || null })} /></div>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </>
  );
}
