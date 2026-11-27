import { FormEvent, KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

/** Confirmation and question popups in the app's own design, instead of the browser's window.confirm / window.prompt. */
export interface ConfirmOptions { title: string; message: string; confirmLabel?: string; cancelLabel?: string; /** destructive actions: red button, and Cancel has the focus */ danger?: boolean }
export interface PromptOptions extends ConfirmOptions { /** label of the text box */ inputLabel: string; maxLength?: number; /** the button stays off until this many characters are typed (default 1) */ minLength?: number }

interface Request extends ConfirmOptions { inputLabel?: string; maxLength?: number; minLength?: number; done: (answer: string | null) => void }

let present: ((r: Request) => void) | null = null;

function ask(options: ConfirmOptions & { inputLabel?: string; maxLength?: number; minLength?: number }): Promise<string | null> {
  // with no host on screen nothing can be asked: the safe answer is "no"
  return new Promise((done) => { if (present) present({ ...options, done }); else done(null); });
}

export const confirmDialog = async (options: ConfirmOptions) => (await ask(options)) !== null;
/** The typed text, or null if the person cancelled. */
export const promptDialog = (options: PromptOptions) => ask(options);

/** Put once near the root of the app. */
export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const current = useRef<Request | null>(null);

  useEffect(() => {
    const finish = () => { current.current?.done(null); current.current = null; };
    present = (r) => { finish(); current.current = r; setRequest(r); }; // a newer question cancels an unanswered one
    const leave = () => { finish(); setRequest(null); }; // browser back / forward: the question belongs to the screen being left
    window.addEventListener('popstate', leave);
    return () => { present = null; finish(); window.removeEventListener('popstate', leave); };
  }, []);

  if (!request) return null;
  return <Dialog key={`${request.title}|${request.message}`} request={request} close={(answer) => { current.current = null; setRequest(null); request.done(answer); }} />;
}

function Dialog({ request, close }: { request: Request; close: (answer: string | null) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const box = useRef<HTMLFormElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const asking = request.inputLabel !== undefined;
  const tooShort = asking && text.trim().length < (request.minLength ?? 1);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (input.current ?? (request.danger ? cancel.current : ok.current))?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [request]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
    if (e.key !== 'Tab') return;
    // keep the focus inside the popup
    const stops = Array.from(box.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? []);
    const first = stops[0]; const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (tooShort) { input.current?.focus(); return; }
    close(asking ? text.trim() : '');
  }

  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(null); }} onKeyDown={onKeyDown}>
      <form ref={box} className={request.danger ? 'modal danger' : 'modal'} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-m`} onSubmit={submit} noValidate>
        <div className="modal-head">
          <span className="modal-icon" aria-hidden>{request.danger ? '!' : '?'}</span>
          <h2 id={`${id}-t`}>{request.title}</h2>
        </div>
        <p id={`${id}-m`}>{request.message}</p>
        {asking && (
          <div className="field">
            <label htmlFor={`${id}-i`}>{request.inputLabel}</label>
            <input ref={input} id={`${id}-i`} type="text" value={text} maxLength={request.maxLength ?? 300} autoComplete="off" onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        <div className="modal-actions">
          <button ref={cancel} type="button" className="btn secondary" onClick={() => close(null)}>{request.cancelLabel ?? 'Cancel'}</button>
          <button ref={ok} type="submit" className={request.danger ? 'btn danger' : 'btn'} disabled={tooShort}>{request.confirmLabel ?? 'Confirm'}</button>
        </div>
      </form>
    </div>
  );
}
