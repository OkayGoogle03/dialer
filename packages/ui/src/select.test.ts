import { describe, expect, it } from 'vitest';
import { confirmDialog, promptDialog } from './dialog';
import { matchIndex, nextIndex } from './select';

const options = ['Automatic', 'No prefix', 'Prefix 6', 'Prefix 91'].map((label) => ({ value: label, label }));

describe('app drop-down keyboard', () => {
  it('arrows, Home and End stay inside the list', () => {
    expect(nextIndex('ArrowDown', 3, 4)).toBe(3);
    expect(nextIndex('ArrowUp', 0, 4)).toBe(0);
    expect(nextIndex('End', 0, 4)).toBe(3);
    expect(nextIndex('Home', 3, 4)).toBe(0);
    expect(nextIndex('a', 1, 4)).toBeNull();
    expect(nextIndex('ArrowDown', 0, 0)).toBeNull();
  });

  it('typing jumps to the next matching option, and a longer word narrows it', () => {
    expect(matchIndex(options, 'n', 0)).toBe(1);
    expect(matchIndex(options, 'p', 2)).toBe(3);
    expect(matchIndex(options, 'p', 3)).toBe(2); // wraps
    expect(matchIndex(options, 'prefix 9', 2)).toBe(3);
    expect(matchIndex(options, 'zz', 0)).toBe(-1);
  });
});

describe('app confirmation popup', () => {
  it('answers "no" when it cannot be shown, so nothing is ever done unasked', async () => {
    await expect(confirmDialog({ title: 't', message: 'm' })).resolves.toBe(false);
    await expect(promptDialog({ title: 't', message: 'm', inputLabel: 'Reason' })).resolves.toBeNull();
  });
});
