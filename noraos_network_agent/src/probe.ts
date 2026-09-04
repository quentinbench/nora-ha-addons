// La lib `ipp` est en CommonJS sans types : require dynamique.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ipp = require('ipp');

import { DiscoveredDevice } from './types';
import { identifyRawLanguage, openPrintPorts } from './identify';

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
                    // Formats acceptés : c'est cette liste qui dit si l'imprimante sait lire un PDF.
                    // Une IPP qui ne l'annonce pas sort des pages BLANCHES en déclarant le travail
                    // réussi — il faut alors lui envoyer un raster, pas le PDF.
                    const formats = pa?.['document-format-supported'];
                    done({
                        kind: 'printer',
                        mdnsName: name,
                        host,
                        port,
                        uuid: `ipp:${host}:${port}`,
                        txt: location ? { note: location } : {},
                        capabilities: {
                            protocol: 'ipp',
                            ippUri,
                            manual: true,
                            model: attr(pa, 'printer-make-and-model'),
                            ippFormats: Array.isArray(formats) ? formats.map(String) : (formats ? [String(formats)] : undefined),
                        },
                    });
                },
            );
        } catch {
            clearTimeout(timer);
            done(null);
        }
    });
}


/**
 * Sonde complète d'une imprimante par son adresse : quels ports répondent, et **quel langage**
 * l'imprimante comprend.
 *
 * Le port seul ne suffit pas à décider : ZPL et ESC/POS écoutent tous les deux le 9100. Et une
 * imprimante déclarée en IPP alors qu'elle est sur un port brut imprime la requête HTTP en toutes
 * lettres. On teste donc les ports, puis on interroge l'imprimante elle-même.
 */
export async function probePrinterCapabilities(host: string): Promise<DiscoveredDevice | null> {
    const ports = await openPrintPorts(host);
    if (!ports.length) return null;

    // IPP d'abord : c'est le seul protocole qui sait décliner son identité et ses formats.
    if (ports.includes(631)) {
        const device = await probeIpp(host, 631);
        if (device) {
            (device.capabilities as Record<string, unknown>).openPorts = ports;
            return device;
        }
    }

    if (ports.includes(9100)) {
        const { language, model } = await identifyRawLanguage(host, 9100);
        return {
            kind: 'printer',
            mdnsName: model || `Imprimante réseau ${host}`,
            host,
            port: 9100,
            uuid: `socket:${host}:9100`,
            txt: {},
            capabilities: {
                // Sans réponse de l'imprimante on reste sur « socket » : on ne devine pas un langage,
                // au risque d'envoyer du ZPL à une imprimante à ticket (ou l'inverse).
                protocol: language ?? 'socket',
                socketPort: 9100,
                raw: true,
                model,
                rawLanguage: language,
                openPorts: ports,
            },
        };
    }
    return null;
}
