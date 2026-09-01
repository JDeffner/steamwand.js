import { describe, expect, it } from 'vitest';
import * as flat from '../src/generated';

/**
 * Pins the size of the generated API surface. A generator or SDK change that
 * silently drops methods, callbacks, or layouts must fail here as a wrong
 * number instead of slipping through; update the numbers together with the
 * generated diff when a change is intentional.
 */

const keys = Object.keys(flat);
const ifaceNames = keys.filter((k) => /^ISteam/.test(k) && !/Async$/.test(k));
const asyncNames = keys.filter((k) => /^ISteam/.test(k) && /Async$/.test(k));
const methodCount = (ctor: unknown) =>
  Object.getOwnPropertyNames((ctor as { prototype: object }).prototype).filter((n) => n !== 'constructor').length;
const sumMethods = (names: string[]) =>
  names.reduce((n, k) => n + methodCount((flat as Record<string, unknown>)[k]), 0);

describe('generated API surface', () => {
  it('exposes 25 interface classes with 807 flat methods', () => {
    expect(ifaceNames.length).toBe(25);
    expect(sumMethods(ifaceNames)).toBe(807);
  });

  it('exposes 76 async wrappers across 12 companion classes', () => {
    expect(asyncNames.length).toBe(12);
    expect(sumMethods(asyncNames)).toBe(76);
  });

  it('has a SteamInterfaces getter for every interface class', () => {
    const getters = Object.getOwnPropertyNames(flat.SteamInterfaces.prototype).filter((n) => {
      const d = Object.getOwnPropertyDescriptor(flat.SteamInterfaces.prototype, n);
      return d !== undefined && typeof d.get === 'function';
    });
    expect(getters.length).toBe(ifaceNames.length);
  });

  it('carries 191 callbacks and 215 struct layouts', () => {
    expect(Object.keys(flat.callbacksById).length).toBe(191);
    expect(Object.keys(flat.structLayouts).length).toBe(215);
  });
});
