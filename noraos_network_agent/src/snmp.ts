// La lib `net-snmp` est en CommonJS sans types : require dynamique (même parti pris que `ipp`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const snmp = require('net-snmp');

/** Un consommable relevé sur l'imprimante (toner, tambour, four, bac de récupération…). */
export interface PrinterSupply {
    /** Libellé donné par l'imprimante (« Black Toner Cartridge », « Drum Unit »…). */
    name: string;
    /** Nature normalisée, déduite du type déclaré dans la MIB. */
    kind: 'toner' | 'ink' | 'drum' | 'waste' | 'fuser' | 'maintenance' | 'paper' | 'other';
    /** Niveau restant en pourcentage, `undefined` quand l'imprimante ne le chiffre pas. */
    percent?: number;
    level?: number;
    maxCapacity?: number;
}

/**
 * Unité du compteur de l'imprimante, telle qu'elle la déclare (`prtMarkerCounterUnit`, RFC 3805).
 *
 * Distinction décisive pour chiffrer le papier : `impressions` compte les **faces** imprimées,
 * `sheets` les **feuilles**. En recto-verso, deux faces tiennent sur une feuille — prendre l'un
 * pour l'autre double le coût papier annoncé.
 */
export type PageCountUnit = 'impressions' | 'sheets' | 'other';

export interface PrinterMetrics {
    /** Compteur de pages depuis la mise en service, dans l'unité `pageCountUnit`. */
    pageCount?: number;
    /** Ce que compte réellement `pageCount` : des faces, des feuilles, ou autre chose. */
    pageCountUnit?: PageCountUnit;
    model?: string;
    serialNumber?: string;
    supplies: PrinterSupply[];
    /** Anomalies signalées par la machine elle-même (bourrage, capot ouvert, plus de papier…). */
    errors: string[];
}

/**
 * OID de la **Printer MIB standard (RFC 3805)**, implémentée par la quasi-totalité des imprimantes
 * réseau — Brother, HP, Epson, Zebra, Lexmark… C'est ce choix qui rend la lecture indépendante de
 * la marque : pas de MIB privée, pas de traitement particulier par constructeur.
 */
const OID = {
    model: '1.3.6.1.2.1.25.3.2.1.3.1',
    serial: '1.3.6.1.2.1.43.5.1.1.17.1',
    /** prtMarkerLifeCount : compteur de vie, exprimé dans l'unité ci-dessous. */
    pageCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',
    /**
     * `prtMarkerCounterUnit` : ce que compte `prtMarkerLifeCount`. Sans cette lecture, on prend
     * des faces imprimées pour des feuilles et le coût papier est faux en recto-verso.
     */
    pageCountUnit: '1.3.6.1.2.1.43.10.2.1.3.1.1',
    supplyDescription: '1.3.6.1.2.1.43.11.1.1.6',
    supplyType: '1.3.6.1.2.1.43.11.1.1.5',
    supplyMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
    supplyLevel: '1.3.6.1.2.1.43.11.1.1.9',
    /** Bacs papier : description, capacité et niveau courant. */
    trayDescription: '1.3.6.1.2.1.43.8.2.1.18',
    trayMaxCapacity: '1.3.6.1.2.1.43.8.2.1.9',
    trayLevel: '1.3.6.1.2.1.43.8.2.1.10',
    /** `hrPrinterDetectedErrorState` : anomalies signalées par la machine, en champ de bits. */
    errorState: '1.3.6.1.2.1.25.3.5.1.2.1',
};

/**
 * Anomalies de `hrPrinterDetectedErrorState` (RFC 1759), bit par bit. C'est l'imprimante qui les
 * déclare : un bourrage ou un capot ouvert sont ainsi connus **avant** qu'un utilisateur ne vienne
 * signaler que « ça n'imprime plus ».
 */
const ERROR_BITS = [
    'Papier bas', 'Plus de papier', 'Toner bas', 'Plus de toner',
    'Capot ouvert', 'Bourrage papier', 'Hors ligne', 'Intervention requise',
    'Bac absent', 'Bac de sortie plein', 'Bac de sortie presque plein', 'Bac de sortie absent',
    'Marqueur absent', 'Sortie impossible', 'Conversion impossible', 'Interruption',
];

/** Décode le champ de bits des anomalies déclarées par l'imprimante. */
function decodeErrors(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
    const errors: string[] = [];
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
        for (let bit = 0; bit < 8; bit++) {
            // Le bit de poids fort du premier octet est l'anomalie n° 0.
            if (!(bytes[byteIndex] & (0x80 >> bit))) continue;
            const label = ERROR_BITS[byteIndex * 8 + bit];
            if (label) errors.push(label);
        }
    }
    return errors;
}

/**
 * Nature d'un consommable. **Le libellé prime sur le type déclaré** : les constructeurs sont
 * incohérents sur `prtMarkerSuppliesType`. Une Brother annonce par exemple son tambour avec le
 * type 9 (« fuserOil » dans la norme), ce qui le classerait en four alors qu'on doit commander un
 * tambour.
 */
/**
 * Traduit `prtMarkerCounterUnit` (RFC 3805) en unité exploitable.
 *
 * Seules deux valeurs nous intéressent : `impressions(7)` compte les faces imprimées, `sheets(8)`
 * les feuilles. Tout le reste (caractères, lignes, mètres — cas des traceurs et de certaines
 * étiqueteuses) signifie que le compteur n'est **pas** un compteur de pages : mieux vaut le dire
 * que de le traiter comme tel et facturer du papier au mètre.
 */
export function counterUnitOf(value: number): PageCountUnit | undefined {
    if (value === 7) return 'impressions';
    if (value === 8) return 'sheets';
    return Number.isFinite(value) && value > 0 ? 'other' : undefined;
}

function kindOf(type: number, description: string): PrinterSupply['kind'] {
    if (/drum|tambour|photoconduct|imaging unit/i.test(description)) return 'drum';
    if (/waste|récupération|usagé/i.test(description)) return 'waste';
    if (/fuser|fusion|four\b/i.test(description)) return 'fuser';
    if (/belt|courroie|transfer/i.test(description)) return 'maintenance';
    if (/toner/i.test(description)) return 'toner';
    if (/ink|encre/i.test(description)) return 'ink';
    switch (type) {
        case 3: case 19: return 'toner';
        case 5: case 6: case 7: return 'ink';
        case 4: case 12: return 'waste';
        case 13: case 20: return 'fuser';
        case 8: case 16: case 17: case 18: return 'maintenance';
        default: return 'other';
    }
}

/**
 * Complément **Brother** : le niveau de toner en pourcentage.
 *
 * La norme ne suffit pas ici. Interrogée en MIB standard, une Brother répond « -3 » pour son toner
 * — c'est-à-dire « il en reste », sans chiffre — et « -2 » pour sa capacité. Impossible d'anticiper
 * une commande avec ça. Le constructeur publie l'information dans sa propre MIB, sous forme d'une
 * suite d'enregistrements `[marqueur][type][longueur][valeur]`.
 *
 * La correspondance des marqueurs a été établie en comparant les relevés de trois imprimantes du
 * parc (une monochrome, une seconde monochrome, une couleur) aux valeurs affichées par
 * l'intégration Brother de Home Assistant : 0x81 = noir, 0x82/0x83/0x84 = cyan/magenta/jaune.
 * On n'applique ces valeurs que si elles sont cohérentes (0 à 100).
 */
const BROTHER_COUNTERS_OID = '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0';
const BROTHER_TONER_MARKERS: Record<number, RegExp> = {
    0x81: /black|noir/i,
    0x82: /cyan/i,
    0x83: /magenta/i,
    0x84: /yellow|jaune/i,
};

/** Décode la suite d'enregistrements de la MIB Brother : marqueur → valeur. */
function decodeBrotherRecords(raw: Buffer): Map<number, number> {
    const out = new Map<number, number>();
    let i = 0;
    while (i + 3 <= raw.length) {
        const marker = raw[i];
        if (marker === 0xff) break;
        const length = raw[i + 2];
        if (length <= 0 || i + 3 + length > raw.length) break;
        out.set(marker, raw.readUIntBE(i + 3, length));
        i += 3 + length;
    }
    return out;
}

/** Applique les pourcentages de toner Brother aux consommables dont le niveau est inconnu. */
async function applyBrotherToner(session: any, supplies: PrinterSupply[], timeoutMs: number): Promise<void> {
    const missing = supplies.filter(s => (s.kind === 'toner' || s.kind === 'ink') && s.percent === undefined);
    if (!missing.length) return;

    const scalars = await get(session, [BROTHER_COUNTERS_OID], timeoutMs);
    const raw = scalars.get(BROTHER_COUNTERS_OID);
    if (raw === undefined) return;
    const records = decodeBrotherRecords(Buffer.from(String(raw), 'latin1'));

    for (const [marker, colour] of Object.entries(BROTHER_TONER_MARKERS)) {
        const value = records.get(Number(marker));
        if (value === undefined || value < 0 || value > 100) continue;
        const supply = missing.find(s => colour.test(s.name));
        if (supply) supply.percent = value;
    }
}

/** Parcourt une sous-arborescence SNMP et renvoie index → valeur. */
function walk(session: any, oid: string, timeoutMs: number): Promise<Map<number, string | number>> {
    return new Promise((resolve) => {
        const out = new Map<number, string | number>();
        const timer = setTimeout(() => resolve(out), timeoutMs);
        session.subtree(
            oid,
            (varbinds: any[]) => {
                for (const vb of varbinds) {
                    if (snmp.isVarbindError(vb)) continue;
                    const index = Number(String(vb.oid).split('.').pop());
                    const value = Buffer.isBuffer(vb.value) ? vb.value.toString('latin1') : vb.value;
                    out.set(index, value);
                }
            },
            () => { clearTimeout(timer); resolve(out); },
        );
    });
}

/** Lit une liste d'OID scalaires. */
function get(session: any, oids: string[], timeoutMs: number): Promise<Map<string, string | number>> {
    return new Promise((resolve) => {
        const out = new Map<string, string | number>();
        const timer = setTimeout(() => resolve(out), timeoutMs);
        session.get(oids, (error: any, varbinds: any[]) => {
            clearTimeout(timer);
            if (error) return resolve(out);
            for (const vb of varbinds ?? []) {
                if (snmp.isVarbindError(vb)) continue;
                out.set(String(vb.oid), Buffer.isBuffer(vb.value) ? vb.value.toString('latin1') : vb.value);
            }
            resolve(out);
        });
    });
}

/**
 * Relève les compteurs et les niveaux de consommables d'une imprimante, en SNMP.
 *
 * Pourquoi SNMP plutôt qu'une API constructeur : c'est le seul canal commun à toutes les marques,
 * et il est actif par défaut sur la plupart des imprimantes réseau. Il permet de savoir qu'un
 * tambour est à 2 % **avant** que quelqu'un ne vienne dire que l'imprimante ne marche plus.
 *
 * Best-effort : une imprimante qui ne répond pas, ou dont le SNMP est désactivé, renvoie
 * simplement un relevé vide — ce n'est pas une erreur.
 */
export async function readPrinterMetrics(
    host: string,
    opts: { community?: string; timeoutMs?: number } = {},
): Promise<PrinterMetrics | null> {
    const timeoutMs = opts.timeoutMs ?? 4000;
    let session: any;
    try {
        session = snmp.createSession(host, opts.community ?? 'public', { timeout: 1500, retries: 1 });
    } catch {
        return null;
    }

    try {
        const scalars = await get(session, [OID.model, OID.serial, OID.pageCount, OID.errorState, OID.pageCountUnit], timeoutMs);
        const [descriptions, types, maxima, levels, trays, trayMax, trayLevel] = await Promise.all([
            walk(session, OID.supplyDescription, timeoutMs),
            walk(session, OID.supplyType, timeoutMs),
            walk(session, OID.supplyMaxCapacity, timeoutMs),
            walk(session, OID.supplyLevel, timeoutMs),
            walk(session, OID.trayDescription, timeoutMs),
            walk(session, OID.trayMaxCapacity, timeoutMs),
            walk(session, OID.trayLevel, timeoutMs),
        ]);

        const supplies: PrinterSupply[] = [];
        for (const [index, rawDescription] of descriptions) {
            const name = String(rawDescription ?? '').trim();
            if (!name) continue;
            const level = Number(levels.get(index));
            const maxCapacity = Number(maxima.get(index));
            // Conventions RFC 3805 : -1 « inconnu », -2 « sans limite », -3 « il en reste ».
            // Un pourcentage n'a de sens que si les deux valeurs sont positives.
            const percent = level >= 0 && maxCapacity > 0
                ? Math.max(0, Math.min(100, Math.round((level / maxCapacity) * 100)))
                : undefined;
            supplies.push({
                name,
                kind: kindOf(Number(types.get(index)), name),
                percent,
                level: Number.isFinite(level) ? level : undefined,
                maxCapacity: Number.isFinite(maxCapacity) ? maxCapacity : undefined,
            });
        }

        // Bacs papier : c'est la panne la plus fréquente. Beaucoup d'imprimantes ne chiffrent
        // cependant pas le niveau (elles répondent « il en reste ») : on n'ajoute donc le bac que
        // s'il est réellement mesuré ou vide, plutôt que d'afficher des lignes sans valeur.
        // Pour ces machines-là, l'alerte papier vient de l'état déclaré (« Plus de papier »).
        for (const [index, rawName] of trays) {
            const level = Number(trayLevel.get(index));
            const maxCapacity = Number(trayMax.get(index));
            if (!(level >= 0 && maxCapacity > 0)) continue;
            const name = String(rawName ?? '').trim() || `Bac ${index}`;
            supplies.push({
                name,
                kind: 'paper',
                percent: Math.max(0, Math.min(100, Math.round((level / maxCapacity) * 100))),
                level: Number.isFinite(level) ? level : undefined,
                maxCapacity: Number.isFinite(maxCapacity) ? maxCapacity : undefined,
            });
        }

        // Complément constructeur quand la norme ne chiffre pas le niveau (cas des Brother).
        await applyBrotherToner(session, supplies, timeoutMs);

        const pageCount = Number(scalars.get(OID.pageCount));
        const metrics: PrinterMetrics = {
            pageCount: Number.isFinite(pageCount) && pageCount >= 0 ? pageCount : undefined,
            pageCountUnit: counterUnitOf(Number(scalars.get(OID.pageCountUnit))),
            model: scalars.has(OID.model) ? String(scalars.get(OID.model)).trim() : undefined,
            serialNumber: scalars.has(OID.serial) ? String(scalars.get(OID.serial)).trim() : undefined,
            supplies,
            errors: decodeErrors(scalars.get(OID.errorState)),
        };
        // Rien de rien : l'imprimante ne parle pas SNMP, inutile de remonter un relevé vide.
        if (!metrics.pageCount && !supplies.length && !metrics.model) return null;
        return metrics;
    } catch {
        return null;
    } finally {
        try { session.close(); } catch {/* session déjà fermée */}
    }
}
