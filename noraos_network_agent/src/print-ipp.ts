// La lib `ipp` est en CommonJS sans types : require dynamique.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ipp = require('ipp');

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentDevice } from './types';

/** Construit l'URI IPP d'une imprimante depuis ses infos de découverte. */
function ippUri(device: AgentDevice): string {
    const fromCaps = device.capabilities?.['ippUri'];
    if (typeof fromCaps === 'string' && fromCaps) return fromCaps;
    const rp = String((device.txt as any)?.rp || 'ipp/print').replace(/^\//, '');
    const port = device.port || 631;
    const scheme = device.capabilities?.['secure'] ? 'ipps' : 'ipp';
    return `${scheme}://${device.host}:${port}/${rp}`;
}

/** Options d'impression IPP (recto/verso, couleur). */
export interface PrintOptions {
    /** true = recto/verso (two-sided-long-edge), false = recto (one-sided). */
    duplex?: boolean;
    /** true = couleur, false = monochrome. Ignoré si l'imprimante ne gère pas la couleur. */
    color?: boolean;
}

/** Résolution de rastérisation par défaut (dpi) — 300 est universellement supporté par les lasers. */
const RASTER_DPI = 300;

/** Timeout d'un envoi Print-Job (ms). Borne les imprimantes qui décrochent (Wi-Fi) et ne répondent
 *  jamais — sinon l'appel `ipp` reste bloqué et gèle le traitement des jobs de l'agent. */
const PRINT_TIMEOUT_MS = 90_000;

/**
 * Rastérise un PDF en PWG-Raster via **mutool** (mupdf-tools). Nécessaire pour les imprimantes
 * AirPrint / IPP-Everywhere (Brother HL-Lxxxx, etc.) qui **n'ont pas d'interpréteur PDF** et
 * n'acceptent que du raster (`image/pwg-raster`) : leur envoyer le PDF brut fait sortir des **pages
 * blanches** (le job est pourtant accepté). mutool est léger, sans dépendance CUPS, et fourni par
 * l'image Docker de l'agent (paquet Alpine `mupdf-tools`).
 *
 * Validé de bout en bout (PDF → `mutool draw -F pwg` → Print-Job `image/pwg-raster` → l'imprimante
 * rend la page) sur Brother HL-L2375DW réelle.
 *
 * Retourne le flux PWG-Raster, ou `null` si mutool est absent/échoue (l'appelant retombe alors sur
 * l'ancien envoi brut, pour ne jamais être *pire* qu'avant).
 */
async function rasterizePdfToPwg(pdf: Buffer): Promise<Buffer | null> {
    const base = join(tmpdir(), `mystock-print-${process.pid}-${Date.now()}`);
    const inPdf = `${base}.pdf`;
    const outPwg = `${base}.pwg`;
    await fs.writeFile(inPdf, pdf);
    try {
        // -F pwg : sortie PWG-Raster ; -r : résolution (dpi) ; -c gray : niveaux de gris (lasers N&B).
        const ok = await runOk('mutool', ['draw', '-F', 'pwg', '-r', String(RASTER_DPI), '-c', 'gray', '-o', outPwg, inPdf]);
        if (!ok) return null;
        const data = await fs.readFile(outPwg).catch(() => null);
        return data && data.length ? data : null;
    } finally {
        await fs.unlink(inPdf).catch(() => undefined);
        await fs.unlink(outPwg).catch(() => undefined);
    }
}

/** Exécute une commande et résout `true` si elle se termine avec succès (code 0), `false` sinon (échec/absente). */
function runOk(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args);
        } catch {
            return resolve(false);
        }
        child.on('error', () => resolve(false)); // binaire absent
        child.on('close', (code: number) => resolve(code === 0));
    });
}

/** Un seul essai de Print-Job avec un `document-format` et des données donnés. */
function printJobOnce(
    device: AgentDevice,
    data: Buffer,
    fileName: string,
    documentFormat: string,
    options: PrintOptions,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const printer = ipp.Printer(ippUri(device));
        // Attributs de job optionnels : seulement ceux explicitement demandés, pour ne pas
        // faire échouer une imprimante qui ne supporte pas l'attribut.
        const jobAttrs: Record<string, unknown> = {};
        if (typeof options.duplex === 'boolean') {
            jobAttrs.sides = options.duplex ? 'two-sided-long-edge' : 'one-sided';
        }
        if (typeof options.color === 'boolean') {
            jobAttrs['print-color-mode'] = options.color ? 'color' : 'monochrome';
        }
        const msg: any = {
            'operation-attributes-tag': {
                'requesting-user-name': 'mystock',
                'job-name': fileName,
                'document-format': documentFormat,
            },
            data,
        };
        if (Object.keys(jobAttrs).length) msg['job-attributes-tag'] = jobAttrs;
        // Garde-fou : la lib `ipp` n'a pas de timeout. Une imprimante Wi-Fi qui décroche accepte la
        // connexion TCP mais ne répond jamais au Print-Job → l'appel resterait bloqué à l'infini et
        // gèlerait le traitement des jobs de l'agent. On borne donc chaque essai.
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error(`Timeout IPP (${PRINT_TIMEOUT_MS / 1000}s, format ${documentFormat}) — imprimante injoignable/bloquée`));
        }, PRINT_TIMEOUT_MS);
        printer.execute('Print-Job', msg, (err: any, res: any) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) return reject(err);
            const status = res?.statusCode || '';
            if (typeof status === 'string' && status.startsWith('successful')) return resolve();
            // Certaines imprimantes ne renvoient pas "successful-ok" mais acceptent le job.
            if (res?.['job-attributes-tag']) return resolve();
            reject(new Error(`Impression refusée (format ${documentFormat}) : ${status || 'statut inconnu'}`));
        });
    });
}

/**
 * Envoie un PDF à imprimer via IPP (Print-Job).
 *
 * ⚠️ Rastérisation **opt-in par imprimante** (`capabilities.rasterize === true`), pour ne changer
 * STRICTEMENT RIEN aux imprimantes qui fonctionnent déjà. Certains lasers récents (ex. Brother
 * HL-L2445DW) annoncent l'IPP/AirPrint mais **n'ont pas d'interpréteur PDF** : leur envoyer le PDF
 * brut fait sortir des **pages blanches** (le job est pourtant accepté → statut "done" trompeur).
 * Pour ces modèles-là uniquement, on marque le device `rasterize: true` côté MyStock ; l'agent
 * **rastérise** alors le PDF (mutool) et envoie `image/pwg-raster`.
 *
 * Tous les autres devices (imprimantes qui rendent déjà le PDF correctement) suivent la cascade
 * historique inchangée : `application/pdf` → repli `application/octet-stream`.
 */
export async function printPdf(device: AgentDevice, pdf: Buffer, fileName: string, options: PrintOptions = {}): Promise<void> {
    const forceRaster = device.capabilities?.['rasterize'] === true;
    if (forceRaster) {
        const pwg = await rasterizePdfToPwg(pdf);
        if (pwg) {
            // Rastérisation OK → on envoie le PWG. Si l'envoi échoue (imprimante bloquée/timeout),
            // on laisse l'erreur remonter : NE PAS retomber sur le PDF brut, qui sortirait blanc sur
            // ces modèles (tout l'objet du fix) et re-timeouterait inutilement.
            return printJobOnce(device, pwg, fileName, 'image/pwg-raster', options);
        }
        // Rasteriseur (mutool) indisponible → cascade historique en dernier recours (jamais pire).
        return printPdfLegacy(device, pdf, fileName, options);
    }

    // Comportement historique inchangé pour toutes les imprimantes non marquées.
    return printPdfLegacy(device, pdf, fileName, options);
}

/**
 * Cascade historique : `application/pdf` puis repli `application/octet-stream` (auto-détection).
 * Conservée comme filet de sécurité pour ne jamais régresser par rapport au comportement d'avant
 * l'ajout de la rastérisation.
 */
async function printPdfLegacy(
    device: AgentDevice,
    pdf: Buffer,
    fileName: string,
    options: PrintOptions,
): Promise<void> {
    try {
        await printJobOnce(device, pdf, fileName, 'application/pdf', options);
    } catch (pdfErr) {
        try {
            await printJobOnce(device, pdf, fileName, 'application/octet-stream', options);
        } catch (rawErr) {
            throw new Error(
                `Échec IPP. application/pdf → ${(pdfErr as Error).message} ; ` +
                `application/octet-stream → ${(rawErr as Error).message}`,
            );
        }
    }
}
