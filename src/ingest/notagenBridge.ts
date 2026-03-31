export interface NotaGenBridge {
  abcToMusicXml?: (abcText: string) => Promise<string> | string;
}

declare global {
  interface Window {
    NotaGen?: NotaGenBridge;
  }
}

export async function tryConvertAbcToMusicXmlViaNotaGen(abcText: string): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const convert = window.NotaGen?.abcToMusicXml;
  if (!convert) return null;
  const converted = await convert(abcText);
  if (typeof converted !== 'string' || !converted.trim()) return null;
  return converted;
}
