import koffi from 'koffi';

/**
 * SteamParamStringArray_t: { const char **m_ppStrings; int32 m_nNumStrings }.
 * koffi marshals a JS string array for the char** field, so callers pass
 * `stringArray(['tag1', 'tag2'])` wherever the flat API wants this struct.
 *
 * @see stringArray
 */
export const SteamParamStringArray = koffi.struct('SW_SteamParamStringArray_t', {
  m_ppStrings: koffi.pointer(koffi.types.str),
  m_nNumStrings: 'int32',
});

/**
 * Pointer type for {@link SteamParamStringArray}. The generated interfaces use
 * it as the koffi parameter type wherever the flat API takes a
 * `SteamParamStringArray_t *`.
 */
export const SteamParamStringArrayPtr = koffi.pointer(SteamParamStringArray);

/** JS shape koffi marshals into a `SteamParamStringArray_t`. */
export interface SteamParamStringArrayJs {
  /** The strings. koffi allocates the `const char **` array for them. */
  m_ppStrings: string[];
  /** Number of strings. Must match `m_ppStrings.length`. */
  m_nNumStrings: number;
}

/**
 * Wraps a string array for a flat API parameter of type
 * `SteamParamStringArray_t *`.
 *
 * @param strings - The strings to pass. An empty array is valid.
 * @returns The struct value, with the count already filled in.
 * @example
 * ```ts
 * import { init, stringArray } from 'steamwand.js';
 * const steam = init({ appId: 480 });
 * const handle = steam.ugc.StartItemUpdate(480, 123456789n);
 * steam.ugc.SetItemTags(handle, stringArray(['map', 'coop']), false);
 * ```
 */
export function stringArray(strings: string[]): SteamParamStringArrayJs {
  return { m_ppStrings: strings, m_nNumStrings: strings.length };
}
