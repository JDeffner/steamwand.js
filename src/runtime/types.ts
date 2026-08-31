import koffi from 'koffi';

/**
 * SteamParamStringArray_t: { const char **m_ppStrings; int32 m_nNumStrings }.
 * koffi marshals a JS string array for the char** field, so callers pass
 * `stringArray(['tag1', 'tag2'])` wherever the flat API wants this struct.
 */
export const SteamParamStringArray = koffi.struct('SW_SteamParamStringArray_t', {
  m_ppStrings: koffi.pointer(koffi.types.str),
  m_nNumStrings: 'int32',
});

export const SteamParamStringArrayPtr = koffi.pointer(SteamParamStringArray);

export interface SteamParamStringArrayJs {
  m_ppStrings: string[];
  m_nNumStrings: number;
}

export function stringArray(strings: string[]): SteamParamStringArrayJs {
  return { m_ppStrings: strings, m_nNumStrings: strings.length };
}
