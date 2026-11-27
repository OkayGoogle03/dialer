/* Where call sound can go: speaker, phone (earpiece), Bluetooth or a headset. A web page can only offer what the browser reports:
 *  - computers (Chrome, Edge, the Windows app) list output devices that can be selected;
 *  - Android Chrome lists no outputs, but its microphones are named "Speakerphone", "Headset earpiece", "Bluetooth headset",
 *    and choosing one moves the call sound there too;
 *  - others (for example iPhone) decide for themselves. */

export type SoundKind = 'bluetooth' | 'phone' | 'speaker' | 'headset' | 'default';
export interface SoundDevice { deviceId: string; label: string; groupId?: string }
export interface SoundChoice { id: string; kind: SoundKind; name: string }
export interface SoundChoices { mode: 'output' | 'route' | 'none'; choices: SoundChoice[] }

export const KIND_LABEL: Record<SoundKind, string> = { bluetooth: 'Bluetooth', phone: 'Phone', speaker: 'Speaker', headset: 'Headset', default: 'Default' };

export function kindOf(label: string): SoundKind {
  const l = label.toLowerCase();
  if (/bluetooth|airpods|\bbuds\b|wireless|hands-?free/.test(l)) return 'bluetooth';
  if (/earpiece|handset/.test(l)) return 'phone'; // Android calls the phone's own earpiece "Headset earpiece"
  if (/speaker/.test(l)) return 'speaker';
  if (/headset|headphone|earphone/.test(l)) return 'headset';
  return 'speaker';
}

const real = (d: SoundDevice) => !!d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications' && !!d.label;

export function soundChoices(devices: { mics: SoundDevice[]; speakers: SoundDevice[] }, canChooseOutput: boolean): SoundChoices {
  const outputs = devices.speakers.filter(real);
  if (canChooseOutput && outputs.length) {
    return { mode: 'output', choices: [{ id: '', kind: 'default', name: 'The computer\'s default device' }, ...outputs.map((d) => ({ id: d.deviceId, kind: kindOf(d.label), name: d.label }))] };
  }
  const mics = devices.mics.filter(real);
  if (mics.some((d) => /speakerphone|earpiece|bluetooth/i.test(d.label))) return { mode: 'route', choices: mics.map((d) => ({ id: d.deviceId, kind: kindOf(d.label), name: d.label })) };
  return { mode: 'none', choices: [] };
}

/** The microphone that belongs to an output device (a headset's own mic), so that choosing it also talks through it. '' = default mic. */
export function microphoneFor(outputId: string, devices: { mics: SoundDevice[]; speakers: SoundDevice[] }): string {
  const group = devices.speakers.find((d) => d.deviceId === outputId)?.groupId;
  return (group && devices.mics.filter(real).find((m) => m.groupId === group)?.deviceId) || '';
}
