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
 * États du chargeur automatique (eSCL) traduits en langage d'atelier.
 *
 * Un chargeur vide fait répondre **HTTP 500** à la création du travail chez la plupart des
 * marques : l'agent recopiait « eSCL ScanJobs HTTP 500 », ce qui n'apprenait rien à la personne
 * devant la machine. Constaté en vrai le 07/09 : scanner `State=Idle`, `AdfState=ScannerAdfEmpty`,
 * et un scan demandé sur le chargeur — il ne manquait que la feuille.
 */
const ADF_TROUBLE: Record<string, string> = {
    ScannerAdfEmpty: 'le chargeur est vide — placez le document dans le bac',
    ScannerAdfJam: 'bourrage dans le chargeur',
    ScannerAdfDoorOpen: 'le capot du chargeur est ouvert',
    ScannerAdfMispick: 'le chargeur n\'a pas réussi à entraîner la feuille',
    ScannerAdfProcessing: 'le chargeur est déjà en train de numériser',
};

/** États généraux du scanner qui empêchent de lancer un travail. */
const STATE_TROUBLE: Record<string, string> = {
    Processing: 'le scanner est déjà occupé',
    Testing: 'le scanner est en cours d\'initialisation',
    Stopped: 'le scanner est arrêté — vérifiez le capot et le bac',
    Down: 'le scanner ne répond plus',
};

/** Valeur d'une balise XML, sans dépendance de parsing (les réponses eSCL sont plates). */
function tagValue(xml: string, tag: string): string | undefined {
    const m = new RegExp('<[^>]*' + tag + '[^>]*>([^<]*)<', 'i').exec(xml);
    return m ? m[1].trim() : undefined;
}

/**
 * Ce qui empêche de numériser, en clair — ou `null` si tout va bien.
 *
 * Ne lève jamais et reste bref : un scanner qui ne publie pas son état ne doit pas empêcher
 * d'essayer le scan, ni rallonger l'attente.
 */
async function scannerTrouble(base: string, source: string): Promise<string | null> {
    try {
        const res = await fetch(`${base}/ScannerStatus`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return null;
        const xml = await res.text();
        const state = tagValue(xml, 'State');
        if (state && STATE_TROUBLE[state]) return STATE_TROUBLE[state];
        if (source !== 'Feeder') return null;
        const adf = tagValue(xml, 'AdfState');
        return (adf && ADF_TROUBLE[adf]) || null;
    } catch {
        return null;
    }
}

/**
 * Scan eSCL. Pour l'ADF (source=adf), boucle NextDocument jusqu'au 404 final pour récupérer
 * TOUTES les pages du chargeur, puis assemble en un seul PDF.
 */
export async function scanEscl(device: AgentDevice, settings: Record<string, unknown>): Promise<ScanResult> {
    const base = esclBase(device);
    const source = esclSource(settings);

    // On demande son état à la machine AVANT de lui envoyer un travail : elle sait déjà que son
    // chargeur est vide, et le dire tout de suite évite un aller-retour et un code HTTP opaque.
    const before = await scannerTrouble(base, source);
    if (before) throw new Error(`Scan impossible : ${before}.`);

    const create = await fetch(`${base}/ScanJobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: scanSettingsXml(settings),
        signal: AbortSignal.timeout(30_000),
    });
    if (create.status !== 201) {
        // Refus malgré le contrôle initial : on redemande le motif, l'état a pu changer entre-temps
        // (feuille retirée, autre poste qui a lancé un scan).
        const why = await scannerTrouble(base, source);
        throw new Error(why
            ? `Scan refusé : ${why}. (eSCL ScanJobs HTTP ${create.status})`
            : `eSCL ScanJobs HTTP ${create.status}`);
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
