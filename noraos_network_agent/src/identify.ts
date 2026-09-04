import * as net from 'net';

/** Ports testés lors d'une sonde : IPP, impression brute (JetDirect), LPD. */
export const PROBE_PORTS = [631, 9100, 515];

/** Vrai si le port TCP accepte une connexion (borné dans le temps). */
export function tcpOpen(host: string, port: number, timeoutMs = 900): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

/** Envoie une commande sur le port brut et renvoie la réponse (vide si l'imprimante se tait). */
function askRaw(host: string, port: number, command: Buffer, waitMs = 1200): Promise<string> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const chunks: Buffer[] = [];
        let settled = false;
        const done = (): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(Buffer.concat(chunks).toString('latin1'));
        };
        socket.setTimeout(waitMs + 800);
        socket.once('connect', () => {
            socket.write(command);
            setTimeout(done, waitMs);
        });
        socket.on('data', (d) => chunks.push(d));
        socket.once('timeout', done);
        socket.once('error', done);
        socket.connect(port, host);
    });
}

/**
 * Demande à une imprimante en port brut **quel langage elle parle**.
 *
 * On ne peut pas le déduire du port : ZPL (Zebra) et ESC/POS (ticket) écoutent tous les deux le
 * 9100, et leur envoyer le mauvais langage sort des pages illisibles. On le demande donc à
 * l'imprimante elle-même :
 *   - `~HI` est la commande d'identification ZPL : une Zebra répond son modèle et sa version ;
 *   - `GS I 67` est l'identification ESC/POS : une imprimante à ticket répond son nom de modèle.
 *
 * Best-effort : beaucoup de modèles ne répondent rien, et c'est une information, pas un échec —
 * l'utilisateur choisit alors le type lui-même.
 */
export async function identifyRawLanguage(host: string, port = 9100): Promise<{ language?: 'zpl' | 'escpos'; model?: string }> {
    const zebra = await askRaw(host, port, Buffer.from('~HI\r\n', 'ascii'));
    // Réponse Zebra typique : « ZBRPRINTER,V45.11.7Z,8,4096KB,… » ou le nom du modèle.
    if (/zbr|zebra|,V\d+\./i.test(zebra)) {
        return { language: 'zpl', model: zebra.replace(/[\x00-\x1f]/g, ' ').trim().split(',')[0] || 'Zebra' };
    }

    // ESC/POS : GS I 67 → nom du modèle ; certains modèles ne renvoient qu'un identifiant court.
    const escpos = await askRaw(host, port, Buffer.from([0x1d, 0x49, 67]));
    const cleaned = escpos.replace(/[\x00-\x1f]/g, '').trim();
    if (cleaned.length >= 2) return { language: 'escpos', model: cleaned };

    return {};
}

/** Ports ouverts parmi ceux qui nous intéressent. */
export async function openPrintPorts(host: string): Promise<number[]> {
    const results = await Promise.all(PROBE_PORTS.map(async (p) => ((await tcpOpen(host, p)) ? p : 0)));
    return results.filter(Boolean);
}
