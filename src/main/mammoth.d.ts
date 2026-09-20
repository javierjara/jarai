// mammoth non pubblica tipi propri né esiste un pacchetto @types/mammoth:
// dichiarazione minima per l'unica funzione usata in documentTools.ts.
declare module 'mammoth' {
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<{ value: string; messages: unknown[] }>;
}
