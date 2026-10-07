import { describe, expect, it } from 'vitest';
import { featherFingerprint } from '../src/art/feather-fingerprint';

describe('source feather identity', () => {
  it('retains each identity across calls and distinguishes the five source IDs', () => {
    const ids = ['atlas', 'northstar', 'garden', 'quiet', 'orange'];
    const geometries = ids.map(featherFingerprint);
    ids.forEach((id, index) => expect(featherFingerprint(id)).toEqual(geometries[index]));
    expect(new Set(geometries.map(value => value.contours.join(''))).size).toBe(ids.length);
  });
  it('produces finite closed contours within the identity viewBox even for unusual IDs', () => {
    for (const id of ['', 'quiet', '🦜', 'a'.repeat(1000)]) {
      const geometry = featherFingerprint(id);
      expect(Number.isFinite(geometry.phase)).toBe(true);
      for (const contour of geometry.contours) {
        expect(contour.startsWith('M')).toBe(true);
        expect(contour.endsWith('Z')).toBe(true);
        const coordinates = contour.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        coordinates.forEach((coordinate, index) => {
          expect(Number.isFinite(coordinate)).toBe(true);
          expect(coordinate).toBeGreaterThanOrEqual(index % 2 ? -119 : -42);
          expect(coordinate).toBeLessThanOrEqual(index % 2 ? 16 : 42);
        });
      }
      for (const barb of geometry.barbs) expect(barb).not.toMatch(/NaN|Infinity/);
    }
  });
});
