import { describe, expect, it } from 'vitest';
import {
  isFiniteNumber,
  isNonNegativeFiniteNumber,
  isPositiveFiniteNumber,
  getErrorMessage,
  createDownloadRequest,
  AREA_SELECTION_CANCELLED
} from '../src/shared/utils';

describe('utils', () => {
  describe('isFiniteNumber', () => {
    it('returns true for finite numbers', () => {
      expect(isFiniteNumber(42)).toBe(true);
      expect(isFiniteNumber(0)).toBe(true);
      expect(isFiniteNumber(-1)).toBe(true);
      expect(isFiniteNumber(3.14)).toBe(true);
    });

    it('returns false for NaN', () => {
      expect(isFiniteNumber(NaN)).toBe(false);
    });

    it('returns false for Infinity', () => {
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
    });

    it('returns false for non-numbers', () => {
      expect(isFiniteNumber('42')).toBe(false);
      expect(isFiniteNumber(null)).toBe(false);
      expect(isFiniteNumber(undefined)).toBe(false);
      expect(isFiniteNumber({})).toBe(false);
    });
  });

  describe('isPositiveFiniteNumber', () => {
    it('returns true for positive finite numbers', () => {
      expect(isPositiveFiniteNumber(1)).toBe(true);
      expect(isPositiveFiniteNumber(0.1)).toBe(true);
    });

    it('returns false for zero', () => {
      expect(isPositiveFiniteNumber(0)).toBe(false);
    });

    it('returns false for negative numbers', () => {
      expect(isPositiveFiniteNumber(-1)).toBe(false);
    });

    it('returns false for NaN and Infinity', () => {
      expect(isPositiveFiniteNumber(NaN)).toBe(false);
      expect(isPositiveFiniteNumber(Infinity)).toBe(false);
    });
  });

  describe('isNonNegativeFiniteNumber', () => {
    it('returns true for non-negative numbers', () => {
      expect(isNonNegativeFiniteNumber(0)).toBe(true);
      expect(isNonNegativeFiniteNumber(1)).toBe(true);
    });

    it('returns false for negative numbers', () => {
      expect(isNonNegativeFiniteNumber(-1)).toBe(false);
    });

    it('returns false for NaN and Infinity', () => {
      expect(isNonNegativeFiniteNumber(NaN)).toBe(false);
      expect(isNonNegativeFiniteNumber(Infinity)).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('extracts message from Error objects', () => {
      expect(getErrorMessage(new Error('test message'))).toBe('test message');
    });

    it('converts other values to string', () => {
      expect(getErrorMessage('string error')).toBe('string error');
      expect(getErrorMessage(42)).toBe('42');
    });

    it('returns "Unknown error" for null/undefined', () => {
      expect(getErrorMessage(null)).toBe('Unknown error');
      expect(getErrorMessage(undefined)).toBe('Unknown error');
    });
  });

  describe('createDownloadRequest', () => {
    it('creates correct download options', () => {
      const request = createDownloadRequest('data:image/png;base64,abc', 'test.png', true);
      expect(request).toEqual({
        url: 'data:image/png;base64,abc',
        filename: 'test.png',
        conflictAction: 'uniquify',
        saveAs: true
      });
    });

    it('respects askWhereToSave parameter', () => {
      const request = createDownloadRequest('url', 'file.png', false);
      expect(request.saveAs).toBe(false);
    });
  });

  describe('AREA_SELECTION_CANCELLED', () => {
    it('has expected value', () => {
      expect(AREA_SELECTION_CANCELLED).toBe('Area selection cancelled.');
    });
  });
});
