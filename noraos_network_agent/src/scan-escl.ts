import { AgentDevice, ScanResult } from './types';
import { jpegPagesToPdf } from './pages-to-pdf';

/** Base eSCL d'un scanner (ex: http://192.168.1.51:8080/eSCL). */
function esclBase(device: AgentDevice): string {
    const base = device.capabilities?.['esclBase'];
    if (typeof base === 'string' && base) return base.replace(/\/+$/, '');
    const scheme = device.capabilities?.['secure'] ? 'https' : 'http';
    const path = String(device.capabilities?.['esclPath'] || '/eSCL').replace(/\/+$/, '');
    return `${scheme}://${device.host}:${device.port || 8080}${path}`;
}

/** Mappe la source logique ('adf'|'flatbed') vers l'InputSource eSCL. */
function esclSource(settings: Record<string, unknown>): string {
    return String(settings['source']) === 'adf' ? 'Feeder' : 'Platen';
}

function scanSettingsXml(settings: Record<string, unknown>): string {
    const source = esclSource(settings);
    const color = (settings['colorMode'] as string) || 'RGB24'; // RGB24 | Grayscale8 | BlackAndWhite1
    const resolution = Number(settings['resolution']) || 300;
    // Recto/verso : uniquement pertinent depuis le chargeur (Feeder). Sur vitre (Platen) on ignore.
    const duplex = !!settings['duplex'] && source === 'Feeder';
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" ' +
        'xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">' +
        '<pwg:Version>2.6</pwg:Version>' +
        '<scan:Intent>Document</scan:Intent>' +
        '<pwg:InputSource>' + source + '</pwg:InputSource>' +
        (duplex ? '<scan:Duplex>true</scan:Duplex>' : '') +
        '<scan:ColorMode>' + color + '</scan:ColorMode>' +
        '<scan:XResolution>' + resolution + '</scan:XResolution>' +
        '<scan:YResolution>' + resolution + '</scan:YResolution>' +
        // On demande du JPEG par page et on assemble nous-mêmes en PDF (robuste pour l'ADF multi-pages).
        '<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>' +
        '</scan:ScanSettings>'
    );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan eSCL. Pour l'ADF (source=adf), boucle NextDocument jusqu'au 404 final pour récupérer
 * TOUTES les pages du chargeur, puis assemble en un seul PDF.
 */
export async function scanEscl(device: AgentDevice, settings: Record<string, unknown>): Promise<ScanResult> {
    const base = esclBase(device);
    const create = await fetch(`${base}/ScanJobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: scanSettingsXml(settings),
    });
    if (create.status !== 201) {
        throw new Error(`eSCL ScanJobs HTTP ${create.status}`);
    }
    const location = create.headers.get('location');
    if (!location) throw new Error('eSCL : header Location manquant');
    const jobUrl = location.startsWith('http') ? location : `${base.replace(/\/eSCL.*$/, '')}${location}`;

    const pages: Buffer[] = [];
    for (let i = 0; i < 200; i++) {
        const res = await fetch(`${jobUrl}/NextDocument`);
        if (res.status === 404) break;               // plus de page (fin du chargeur)
        if (res.status === 503 || res.status === 409) { await sleep(800); continue; } // pas prêt
        if (!res.ok) throw new Error(`eSCL NextDocument HTTP ${res.status}`);
        pages.push(Buffer.from(await res.arrayBuffer()));
    }
    if (!pages.length) throw new Error('eSCL : aucun document reçu');

    const pdf = await jpegPagesToPdf(pages);
    return { buffer: pdf, mime: 'application/pdf', fileName: `scan-${Date.now()}.pdf` };
}
