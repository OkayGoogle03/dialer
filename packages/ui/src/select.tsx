import { KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface SelectOption { value: string; label: string }

const LIST_HEIGHT = 288;
const GAP = 6;

/** The option to move to for a key press, or null if the key does not move. */
export function nextIndex(key: string, current: number, count: number): number | null {
  if (!count) return null;
  if (key === 'ArrowDown') return Math.min(current + 1, count - 1);
  if (key === 'ArrowUp') return Math.max(current - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'PageDown') return Math.min(current + 8, count - 1);
  if (key === 'PageUp') return Math.max(current - 8, 0);
  return null;
}

/** Type-ahead: the next option (after the current one, wrapping) whose label starts with what was typed. */
export function matchIndex(options: SelectOption[], typed: string, current: number): number {
  const t = typed.toLowerCase();
  const start = t.length > 1 ? current : current + 1; // a growing word may stay on the current option
  for (let i = 0; i < options.length; i++) {
    const at = (Math.max(start, 0) + i) % options.length;
    if (options[at].label.toLowerCase().startsWith(t)) return at;
  }
  return -1;
}

/**
 * Drop-down in the app's own design (the browser's native list cannot be styled). Same use as a <select>: value, options and
 * onChange(e) with e.target.value. Full keyboard support: arrows, Home / End, Enter, Space, Escape, and typing to jump.
 * The list is shown in the browser's top layer (popover), so cards and scrolling areas never cut it off.
 */
export function SelectField({ label, options, value, onChange, disabled }: {
  label: string; options: SelectOption[]; value: string; onChange: (e: { target: { value: string } }) => void; disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const selected = options.findIndex((o) => o.value === value);
  const shown = options[selected] ?? options[0];

  const show = (at = Math.max(selected, 0)) => { if (disabled) return; setActive(at); setOpen(true); };
  const choose = (at: number) => {
    const o = options[at];
    setOpen(false);
    button.current?.focus();
    if (o && o.value !== value) onChange({ target: { value: o.value } });
  };

  // under the button, or above it when there is more room there; never outside the window
  const place = useCallback(() => {
    const b = button.current?.getBoundingClientRect(); const l = list.current;
    if (!b || !l) return;
    const below = window.innerHeight - b.bottom - GAP - 8;
    const above = b.top - GAP - 8;
    const up = below < Math.min(LIST_HEIGHT, l.scrollHeight) && above > below;
    const width = Math.min(Math.max(b.width, 180), window.innerWidth - 16);
    l.style.width = `${width}px`;
    l.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - width - 8))}px`;
    l.style.maxHeight = `${Math.max(96, Math.min(LIST_HEIGHT, up ? above : below))}px`;
    l.style.top = up ? 'auto' : `${b.bottom + GAP}px`;
    l.style.bottom = up ? `${window.innerHeight - b.top + GAP}px` : 'auto';
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const l = list.current as (HTMLUListElement & { showPopover?: () => void }) | null;
    try { l?.showPopover?.(); } catch { /* already shown, or not supported: it is positioned either way */ }
    place();
  }, [open, place, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);

  useEffect(() => { if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' }); }, [open, active]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key === 'Enter' || (e.key === ' ' && !typed.current.text)) { e.preventDefault(); if (open) choose(active); else show(); return; }
    const move = nextIndex(e.key, active, options.length);
    if (move !== null) { e.preventDefault(); if (open) setActive(move); else show(e.key === 'Home' || e.key === 'End' ? move : undefined); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 700 ? e.key : typed.current.text + e.key, at: now };
      setTimeout(() => { if (Date.now() - typed.current.at >= 700) typed.current.text = ''; }, 750);
      const hit = matchIndex(options, typed.current.text, open ? active : selected);
      if (hit >= 0) { if (open) setActive(hit); else show(hit); }
    }
  }

  return (
    <div className="field">
      <label id={`${id}-l`} htmlFor={id}>{label}</label>
      <button ref={button} id={id} type="button" className="select" disabled={disabled} role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? `${id}-o${active}` : undefined} aria-labelledby={`${id}-l ${id}-v`}
        onClick={() => { button.current?.focus(); if (open) setOpen(false); else show(); }} onKeyDown={onKeyDown}>
        <span id={`${id}-v`} className="select-value" data-value={shown?.value ?? ''}>{shown?.label ?? 'No options'}</span>
        <span className="select-arrow" aria-hidden />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} className="select-list" role="listbox" aria-labelledby={`${id}-l`} popover="manual">
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-o${i}`} role="option" aria-selected={i === selected} className={i === active ? 'active' : undefined}
              onPointerMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
              <span>{o.label}</span>{i === selected && <span className="select-tick" aria-hidden>✓</span>}
            </li>
          ))}
          {!options.length && <li className="select-empty" role="option" aria-selected={false} aria-disabled>No options</li>}
        </ul>
      )}
    </div>
  );
}
