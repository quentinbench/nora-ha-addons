import * as net from 'net';

import { AgentDevice } from './types';

/**
 * Imprime sur une imprimante à ticket ESC/POS (thermique 80mm) via une socket TCP brute.
 *
 * Contrairement aux imprimantes IPP (cf. `print-ipp.ts`), une tête thermique n'accepte pas
 * un PDF : elle reçoit directement un flux d'octets ESC/POS (init + image raster + coupe),
 * **construit côté backend** (cf. `escpos.encoder.ts`). L'agent ne fait que l'écrire sur le
 * port d'impression brut (RAW/JetDirect, 9100 par défaut).
 *
 * Le port 9100 ne renvoie pas d'ACK applicatif → on considère le job réussi dès que la socket
 * s'est fermée proprement après le flush. Une IP injoignable / un refus de connexion remontent
 * via `error`/`timeout` (job en erreur, comme le fire-and-forget IPP).
 */
export function printEscpos(device: AgentDevice, bytes: Buffer, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
        const host = device.host;
        const port = device.port || 9100;
        if (!host) {
            reject(new Error('Hôte imprimante manquant'));
            return;
        }
        const socket = new net.Socket();
        let settled = false;
        const done = (err?: Error): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (err) reject(err); else resolve();
        };

        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => done(new Error(`Délai dépassé en écrivant sur ${host}:${port}`)));
        socket.on('error', (e) => done(e));
        // Fermeture propre après end() = succès (sauf si une erreur a déjà été signalée).
        socket.on('close', () => done());

        socket.connect(port, host, () => {
            socket.write(bytes, (e) => {
                if (e) return done(e);
                socket.end(); // FIN après flush TCP
            });
        });
    });
}
