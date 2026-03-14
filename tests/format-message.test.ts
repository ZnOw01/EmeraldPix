import { describe, expect, it } from 'vitest';
import { formatMessage } from '../src/shared/format-message';

describe('format-message', () => {
  it('interpolates named placeholders', () => {
    expect(formatMessage('Saved {count} files', { count: 3 })).toBe('Saved 3 files');
  });

  it('replaces missing values with empty strings', () => {
    expect(formatMessage('Hello {name}!', {})).toBe('Hello !');
  });

  it('serializes dates as ISO strings', () => {
    const date = new Date('2026-03-05T12:30:00.000Z');
    expect(formatMessage('Checked at {when}', { when: date })).toBe(
      'Checked at 2026-03-05T12:30:00.000Z'
    );
  });

  it('serializes booleans and zero without dropping falsy values', () => {
    expect(formatMessage('enabled={enabled}, retries={count}', { enabled: false, count: 0 })).toBe(
      'enabled=false, retries=0'
    );
  });

  it('replaces repeated placeholders consistently', () => {
    expect(formatMessage('{name} -> {name}', { name: 'ScreenCap' })).toBe('ScreenCap -> ScreenCap');
  });
});
