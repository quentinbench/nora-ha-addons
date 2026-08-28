// La lib `ipp` est en CommonJS sans types : require dynamique.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ipp = require('ipp');

import { DiscoveredDevice } from './types';

/** Première valeur exploitable d'un attribut IPP (les valeurs sont parfois des tableaux). */
function attr(obj: Record<string, unknown> | undefined, key: string): string | undefined {
    const v = obj?.[key];
    if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
    return v != null ? String(v) : undefined;
}

/**
 * Sonde une imprimante IPP par IP (« force la recherche ») via Get-Printer-Attributes.
 * Retourne un DiscoveredDevice exploitable par le backend (POST /devices), ou null si injoignable.
 */
export function probeIpp(host: string, port = 631): Promise<DiscoveredDevice | null> {
    return new Promise((resolve) => {
        const ippUri = `ipp://${host}:${port}/ipp/print`;
        let settled = false;
        const done = (d: DiscoveredDevice | null) => { if (!settled) { settled = true; resolve(d); } };
        // Garde-fou : si l'imprimante ne répond jamais, on abandonne au bout de 8 s.
        const timer = setTimeout(() => done(null), 8000);
        try {
            const printer = ipp.Printer(ippUri);
            printer.execute(
                'Get-Printer-Attributes',
                { 'operation-attributes-tag': { 'requesting-user-name': 'mystock' } },
                (err: any, res: any) => {
                    clearTimeout(timer);
                    if (err) return done(null);
                    const pa = res?.['printer-attributes-tag'] as Record<string, unknown> | undefined;
                    const name = attr(pa, 'printer-make-and-model') || attr(pa, 'printer-name') || `Imprimante (${host})`;
                    const location = attr(pa, 'printer-location');
                    done({
                        kind: 'printer',
                        mdnsName: name,
                        host,
                        port,
                        uuid: `ipp:${host}:${port}`,
                        txt: location ? { note: location } : {},
                        capabilities: { protocol: 'ipp', ippUri, manual: true },
                    });
                },
            );
        } catch {
            clearTimeout(timer);
            done(null);
        }
    });
}
