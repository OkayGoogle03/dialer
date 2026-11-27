import { describe, expect, it } from 'vitest';
import { kindOf, microphoneFor, soundChoices } from './soundDevices';

const d = (deviceId: string, label: string, groupId = '') => ({ deviceId, label, groupId });

describe('where call sound can go', () => {
  it('recognises device names', () => {
    expect(['Bluetooth headset', 'Headset (OnePlus Nord Buds)', 'Headset earpiece', 'Speakerphone', 'Speakers (Realtek Audio)', 'Wired headset', 'Headphones (USB)'].map(kindOf))
      .toEqual(['bluetooth', 'bluetooth', 'phone', 'speaker', 'speaker', 'headset', 'headset']);
  });

  it('on a computer offers the output devices, without the browser\'s duplicate default entries', () => {
    const r = soundChoices({ mics: [], speakers: [d('default', 'Default - Speakers'), d('communications', 'Communications - Headset'), d('s1', 'Speakers (Realtek Audio)'), d('b1', 'Headset (OnePlus Nord Buds)')] }, true);
    expect(r.mode).toBe('output');
    expect(r.choices.map((c) => `${c.id}:${c.kind}`)).toEqual([':default', 's1:speaker', 'b1:bluetooth']);
  });

  it('on an Android phone offers speaker, phone and Bluetooth through its named microphones', () => {
    const r = soundChoices({ mics: [d('default', 'Default'), d('a', 'Speakerphone'), d('b', 'Headset earpiece'), d('c', 'Bluetooth headset')], speakers: [] }, true);
    expect(r.mode).toBe('route');
    expect(r.choices.map((c) => c.kind)).toEqual(['speaker', 'phone', 'bluetooth']);
  });

  it('offers nothing it cannot do: names hidden, plain microphones only, or output choice unsupported', () => {
    expect(soundChoices({ mics: [d('x', '')], speakers: [d('y', '')] }, true).mode).toBe('none');
    expect(soundChoices({ mics: [d('m', 'iPhone Microphone')], speakers: [] }, false).mode).toBe('none');
    expect(soundChoices({ mics: [], speakers: [d('s', 'Speakers')] }, false).mode).toBe('none');
  });

  it('uses a headset\'s own microphone with it', () => {
    const devices = { mics: [d('m1', 'Laptop mic', 'g0'), d('m2', 'Buds mic', 'g2')], speakers: [d('s2', 'Buds', 'g2'), d('s3', 'HDMI', 'g3')] };
    expect(microphoneFor('s2', devices)).toBe('m2');
    expect(microphoneFor('s3', devices)).toBe('');
    expect(microphoneFor('', devices)).toBe('');
  });
});
