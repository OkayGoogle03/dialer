import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { GripHorizontal } from 'lucide-react';
import { Alert, Button } from '@dialer/ui';
import { clampPosition, Point } from './popupPosition';
import { SoundPicker } from './SoundPicker';
import type { Softphone } from './SoftphoneContext';

const TITLE: Record<string, string> = { dialing: 'Dialling…', ringing: 'Ringing…', in_call: 'In call', incoming: 'Incoming call' };

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span> · {String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

/**
 * Top right, movable. An incoming call shows it on every screen, with the caller's details, Answer and Reject. During any call it stays
 * available on the other screens (the Softphone screen has its own controls).
 */
export function CallPopup({ sp }: { sp: Softphone }) {
  const { call } = sp;
  const onPhoneScreen = useLocation().pathname === '/softphone';
  const visible = call.state === 'incoming' || (call.state !== 'idle' && !onPhoneScreen);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Point | null>(null); // pointer position inside the popup while dragging
  const [pos, setPos] = useState<Point | null>(null); // null = the standard place, top right
  useEffect(() => { if (call.state === 'idle') setPos(null); }, [call.state]);

  const place = (p: Point) => {
    const el = box.current;
    return el ? clampPosition(p, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }) : p;
  };
  // keep it on the screen when the window gets smaller or the phone is turned
  useEffect(() => {
    if (!visible) return;
    const fit = () => setPos((p) => (p ? place(p) : p));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [visible]);

  if (!visible) return null;

  function start(e: ReactPointerEvent<HTMLDivElement>) {
    const r = box.current!.getBoundingClientRect();
    drag.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current) setPos(place({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }));
  }
  function end() { drag.current = null; }

  const incoming = call.state === 'incoming';
  return (
    <div ref={box} className="call-pop" role="dialog" aria-label={TITLE[call.state]} style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}>
      <div className="call-pop-bar" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Drag to move">
        <b aria-live="assertive">{TITLE[call.state]}{call.state === 'in_call' && call.startedAt ? <Elapsed since={call.startedAt} /> : null}</b>
        <GripHorizontal size={18} aria-hidden />
      </div>
      <div className="call-pop-body">
        <strong>{call.callerName || (incoming ? 'Unknown caller' : call.number)}</strong>
        <div className="hint">{call.direction === 'in' ? 'From' : 'To'} {call.number}{sp.account ? ` · ${sp.account.callServer.name} · your line ${sp.account.sipId}` : ''}</div>
        {sp.error && <Alert>{sp.error}</Alert>}
        {/* the red button is always the second one, and the buttons are never re-used between the two states: a double click on Answer must not
            land on Hang up */}
        {incoming ? (
          <div className="row" key="incoming">
            <Button busy={!!call.answering} disabled={!!call.answering} onClick={sp.answer}>{call.answering ? 'Answering…' : 'Answer'}</Button>
            <Button variant="danger" onClick={sp.hangup}>Reject</Button>
          </div>
        ) : (
          <div className="row" key="active">
            <Button variant="secondary" disabled={call.state !== 'in_call'} onClick={sp.mute}>{call.muted ? 'Unmute' : 'Mute'}</Button>
            <Button variant="danger" onClick={sp.hangup}>Hang up</Button>
          </div>
        )}
        <SoundPicker sp={sp} />
        {!onPhoneScreen && <Link to="/softphone" className="hint">Open Softphone</Link>}
      </div>
    </div>
  );
}
