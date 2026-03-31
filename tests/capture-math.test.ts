import { describe, expect, it } from 'vitest';
import { buildCapturePlan, generateAxisStops, safeMax } from '../src/shared/capture-math';

describe('capture-math', () => {
  describe('safeMax', () => {
    it('returns the maximum value from an array', () => {
      expect(safeMax([1, 5, 3, 9, 2])).toBe(9);
    });

    it('returns 0 for empty array', () => {
      expect(safeMax([])).toBe(0);
    });

    it('handles negative numbers', () => {
      expect(safeMax([-5, -1, -10])).toBe(-1);
    });

    it('handles single element', () => {
      expect(safeMax([42])).toBe(42);
    });

    it('filters out NaN values', () => {
      expect(safeMax([1, NaN, 5, NaN, 3])).toBe(5);
    });
  });

  describe('generateAxisStops', () => {
    it('generates stops from 0 to max position', () => {
      const stops = generateAxisStops(1000, 200);
      expect(stops).toEqual([0, 200, 400, 600, 800, 1000]);
    });

    it('includes max position when not exactly divisible', () => {
      const stops = generateAxisStops(1000, 300);
      expect(stops).toEqual([0, 300, 600, 900, 1000]);
    });

    it('handles max position of 0', () => {
      const stops = generateAxisStops(0, 100);
      expect(stops).toEqual([0]);
    });

    it('handles step larger than max position', () => {
      const stops = generateAxisStops(50, 100);
      expect(stops).toEqual([0, 50]);
    });
  });

  describe('buildCapturePlan', () => {
    it('returns single tile for small pages', () => {
      const plan = buildCapturePlan(800, 600, 1920, 1080);
      expect(plan.length).toBe(1);
      expect(plan[0]).toEqual([0, 0]);
    });

    it('creates multiple tiles for tall pages', () => {
      const plan = buildCapturePlan(800, 3000, 800, 600);
      expect(plan.length).toBeGreaterThan(1);
      // All tiles should have x=0 for single-width page
      plan.forEach(([x]) => expect(x).toBe(0));
    });

    it('creates grid for wide and tall pages', () => {
      const plan = buildCapturePlan(3000, 3000, 800, 600);
      expect(plan.length).toBeGreaterThan(1);
      // Should have tiles at different x positions
      const uniqueX = new Set(plan.map(([x]) => x));
      expect(uniqueX.size).toBeGreaterThan(1);
    });

    it('creates non-overlapping tiles for clean stitching', () => {
      const plan = buildCapturePlan(800, 2000, 800, 600);
      // Without scroll padding, tiles should be exactly windowHeight apart
      // This prevents overlapping content and ghosting artifacts
      if (plan.length > 1) {
        const [, firstY] = plan[0];
        const [, secondY] = plan[1];
        // Second tile should be exactly windowHeight away (no overlap)
        expect(secondY - firstY).toBe(600);
      }
    });

    it('handles edge case of exact fit', () => {
      const plan = buildCapturePlan(800, 600, 800, 600);
      expect(plan.length).toBe(1);
    });
  });
});
