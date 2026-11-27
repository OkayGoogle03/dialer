import { Bluetooth, Headphones, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { KIND_LABEL, SoundChoice, soundChoices, SoundKind } from './soundDevices';
import type { Softphone } from './SoftphoneContext';

const ICON: Record<SoundKind, typeof Volume2> = { bluetooth: Bluetooth, phone: Smartphone, speaker: Volume2, headset: Headphones, default: Volume2 };

/** Speaker / Phone / Bluetooth / Headset for the call: works while it rings and during it. Shows only what this device really offers. */
export function SoundPicker({ sp }: { sp: Softphone }) {
  const { mode, choices } = soundChoices(sp.devices, sp.sinkSupported);
  const chosen = mode === 'output' ? sp.speakerId : sp.micId;
  // two devices of one kind (two Bluetooth headsets): the device name tells them apart
  const count = (c: SoundChoice) => choices.filter((x) => x.kind === c.kind).length;

  return (
    <div className="sound-pick" role="group" aria-label="Call sound">
      <span className="hint">Call sound</span>
      {!sp.devices.labelled ? (
        <button type="button" className="sound-chip" onClick={() => void sp.grantMic()}><VolumeX size={15} aria-hidden />Show sound devices</button>
      ) : mode === 'none' ? (
        <span className="hint">This browser does not let a website choose. Use your device's own sound or Bluetooth controls.</span>
      ) : (
        <div className="sound-chips">
          {choices.map((c) => {
            const Icon = ICON[c.kind];
            return (
              <button key={c.id || 'default'} type="button" className="sound-chip" aria-pressed={chosen === c.id} title={c.name} aria-label={`${KIND_LABEL[c.kind]}: ${c.name}`} onClick={() => void sp.chooseSound(c.id, mode)}>
                <Icon size={15} aria-hidden />
                <span>{KIND_LABEL[c.kind]}{count(c) > 1 ? <small>{c.name}</small> : null}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
