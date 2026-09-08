/**
 * Agent local MyStock.
 *
 * Déployé sur le LAN d'un site, il ouvre une connexion SSE SORTANTE vers le backend MyStock
 * (NAT-friendly), va chercher les travaux qui l'attendent et en accuse réception.
 *   - découverte : mDNS (imprimantes IPP, scanners eSCL) + WS-Discovery (scanners WSD/Brother) ;
 *   - impression : IPP (PDF) ou socket brute (ESC/POS, ZPL) selon l'appareil ;
 *   - scan : eSCL (AirScan) ou WSD (WS-Scan) selon le protocole de l'appareil.
 *
 * **Protocole 2 — l'agent tire son travail.** Avant, les travaux étaient poussés dans le flux
 * temps réel : un travail lancé pendant une reconnexion était perdu sans laisser de trace, et
 * deux agents connectés pour le même site imprimaient le même document en double. Désormais le
 * flux ne sert qu'à réveiller l'agent ; celui-ci réserve les travaux un par un dans la file du
 * backend, en récupère le contenu, et accuse réception. Les travaux sont traités **en série** :
 * une imprimante en port brut (9100) n'accepte qu'une connexion à la fois.
 *
 * Config par variables d'environnement :
 *   BACKEND_URL    ex: https://client.my-stock.fr
 *   PAIRING_TOKEN  token d'appairage du site (généré dans MyStock)
 */

import * as fs from 'fs';

import { discoverAll } from './discovery';
import { probePrinterCapabilities } from './probe';
import { readPrinterMetrics } from './snmp';
import { printPdf } from './print-ipp';
import { printEscpos } from './print-escpos';
import { scanEscl } from './scan-escl';
import { scanWsd } from './scan-wsd';
import { AgentDevice, DiscoveredDevice } from './types';

/** Version du protocole parlé avec le backend (annoncée à la connexion). */
const PROTOCOL_VERSION = 2;

/**
 * Version de l'agent, **lue dans `package.json`** — plus recopiée à la main.
 *
 * La constante avait dérivé : elle annonçait 0.6.0 alors que l'agent publié était en 0.7.0. Or
 * c'est précisément cette version que MyStock affiche pour repérer un agent resté en arrière —
 * l'information construite après qu'une build d'agent périmée eut fait échouer toutes les
 * étiquettes d'un site pendant des semaines. Une version fausse rend ce garde-fou inutile.
 *
 * `package.json` est le seul fichier présent aussi bien en développement (`ts-node src/`) que
 * dans l'image (le Dockerfile le copie à côté de `dist/`). Il doit rester aligné avec la version
 * de `config.yaml`, qui pilote la mise à jour de l'add-on Home Assistant.
 */
const AGENT_VERSION: string = (() => {
    try {
        return String(JSON.parse(fs.readFileSync(`${__dirname}/../package.json`, 'utf8')).version || 'inconnue');
    } catch {
        return 'inconnue';
    }
})();

/**
 * Config : variables d'environnement (déploiement Docker standalone) OU options de l'add-on
 * Home Assistant (`/data/options.json` : backend_url / pairing_token).
 */
function loadConfig(): { backendUrl: string; token: string; snmpCommunity: string } {
    let backendUrl = process.env.BACKEND_URL || '';
    let token = process.env.PAIRING_TOKEN || '';
    // Communauté SNMP du site : « public » convient à la plupart des parcs, mais une imprimante
    // configurée autrement resterait muette sans qu'on comprenne pourquoi.
    let snmpCommunity = process.env.SNMP_COMMUNITY || '';
    if (!backendUrl || !token || !snmpCommunity) {
        try {
            const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
            backendUrl = backendUrl || opts.backend_url || '';
            token = token || opts.pairing_token || '';
            snmpCommunity = snmpCommunity || opts.snmp_community || '';
        } catch {/* pas en add-on HA */}
    }
    return { backendUrl: backendUrl.replace(/\/+$/, ''), token, snmpCommunity: snmpCommunity || 'public' };
}

const { backendUrl: BACKEND_URL, token: TOKEN, snmpCommunity: DEFAULT_SNMP_COMMUNITY } = loadConfig();
/** Communauté effective : celle du site, ou celle imposée par MyStock lors d'une découverte. */
let snmpCommunity = DEFAULT_SNMP_COMMUNITY;
const RECONNECT_MS = 3000;
const DISCOVERY_MS = Number(process.env.DISCOVERY_MS) || 4000;
/** Filet de sécurité : on repasse prendre le travail même si aucun réveil n'est arrivé. */
const POLL_MS = Number(process.env.POLL_MS) || 30000;

if (!BACKEND_URL || !TOKEN) {
    console.error('[agent] BACKEND_URL et PAIRING_TOKEN sont requis.');
    process.exit(1);
}

/** En-têtes d'authentification. Le jeton passe en en-tête, jamais dans l'URL (journaux d'accès). */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

/**
 * Durée maximale d'un appel court au backend.
 *
 * Sans borne, `fetch` peut attendre **indéfiniment** sur une connexion à moitié morte (NAT qui
 * oublie la session, proxy qui ne répond plus) : le dépilement de la file s'est déjà figé une
 * journée entière de cette façon — en silence, sans exception, donc sans une ligne de journal —
 * pendant que le flux temps réel, qui est un autre chemin de code, continuait de répondre. Le
 * site apparaissait EN LIGNE dans MyStock et n'imprimait plus rien.
 */
const BACKEND_TIMEOUT_MS = 30_000;

/** Transferts de contenu (téléchargement d'un document, envoi d'un scan de plusieurs pages) :
 *  même garde-fou, borne plus large parce que ça pèse parfois quelques mégaoctets. */
const TRANSFER_TIMEOUT_MS = 180_000;

/**
 * `fetch` vers le backend, borné dans le temps.
 *
 * ⚠️ Réservé aux appels COURTS. Le flux SSE est délibérément laissé sans borne : c'est une
 * connexion longue durée, l'abandonner au bout de 30 s la couperait en permanence.
 */
function backendFetch(path: string, init: RequestInit = {}, timeoutMs = BACKEND_TIMEOUT_MS): Promise<Response> {
    return fetch(`${BACKEND_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function postDevices(devices: unknown[]): Promise<void> {
    try {
        await backendFetch('/api/network-agent/devices', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ devices }),
        });
        console.log(`[agent] ${devices.length} appareil(s) remonté(s).`);
    } catch (e) {
        console.error('[agent] POST /devices échec :', (e as Error).message);
    }
}

async function postJobStatus(jobId: string, status: 'done' | 'error', error?: string): Promise<void> {
    try {
        await backendFetch(`/api/network-agent/jobs/${jobId}/result`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ status, error }),
        });
    } catch (e) {
        console.error('[agent] POST job status échec :', (e as Error).message);
    }
}

async function postScanResult(jobId: string, buffer: Buffer, mime: string, fileName: string): Promise<void> {
    const fd = new FormData();
    fd.append('status', 'done');
    fd.append('files', new Blob([new Uint8Array(buffer)], { type: mime }), fileName);
    try {
        await backendFetch(`/api/network-agent/jobs/${jobId}/result`, {
            method: 'POST',
            headers: authHeaders(),
            body: fd,
        }, TRANSFER_TIMEOUT_MS);
        console.log(`[agent] scan ${jobId} envoyé (${buffer.length} octets).`);
    } catch (e) {
        console.error('[agent] POST scan result échec :', (e as Error).message);
        await postJobStatus(jobId, 'error', (e as Error).message);
    }
}

async function discover(options: { snmpCommunity?: string } = {}): Promise<void> {
    if (options.snmpCommunity) snmpCommunity = options.snmpCommunity;
    try {
        const devices = await discoverAll(DISCOVERY_MS);
        await enrichWithSupplies(devices);
        await postDevices(devices);
    } catch (e) {
        console.error('[agent] découverte échec :', (e as Error).message);
    }
}

/**
 * Relève, pour chaque imprimante trouvée, son compteur de pages et ses niveaux de consommables.
 *
 * C'est ce qui permet de commander un tambour **avant** qu'il ne soit vide, au lieu d'apprendre le
 * problème quand quelqu'un vient dire que l'imprimante ne marche plus. Interrogation en SNMP, le
 * seul canal commun à toutes les marques ; une imprimante qui n'y répond pas est simplement passée.
 */
async function enrichWithSupplies(devices: DiscoveredDevice[]): Promise<void> {
    const printers = devices.filter((d) => d.kind === 'printer');
    const CONCURRENCY = 6;
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < printers.length) {
            const device = printers[cursor++];
            const metrics = await readPrinterMetrics(device.host, { community: snmpCommunity }).catch(() => null);
            if (!metrics) continue;
            device.pageCount = metrics.pageCount;
            // Ce que compte réellement le compteur : sans cette unité, des faces imprimées
            // passeraient pour des feuilles et le coût papier serait faux en recto-verso.
            device.pageCountUnit = metrics.pageCountUnit;
            device.supplies = metrics.supplies;
            if (metrics.model && !device.mdnsName) device.mdnsName = metrics.model;
            // Le modèle relevé alimente aussi la reconnaissance automatique du protocole.
            device.capabilities = { ...(device.capabilities ?? {}), model: metrics.model, serialNumber: metrics.serialNumber };
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

/**
 * Envoie un contenu à une imprimante, en refusant explicitement les combinaisons impossibles.
 *
 * C'est le correctif des « pages de caractères incompréhensibles » : quand le protocole de
 * l'appareil n'était pas reconnu, l'ancien agent retombait sur l'impression IPP, ou écrivait un
 * PDF tel quel sur une socket brute. L'imprimante recevait des octets qu'elle ne savait pas lire
 * et les sortait caractère par caractère, sur des dizaines de pages. Un travail impossible doit
 * échouer avec un message, pas gaspiller du papier.
 */
async function sendToPrinter(
    device: AgentDevice,
    payloadKind: string,
    bytes: Buffer,
    fileName: string,
    printOptions: Record<string, unknown>,
): Promise<void> {
    const protocol = String(device?.capabilities?.['protocol'] ?? 'ipp');
    if (!bytes.length) throw new Error(`Contenu vide pour un travail « ${payloadKind} »`);

    const rawProtocols = ['escpos', 'zpl', 'raw', 'socket'];
    if (rawProtocols.includes(protocol)) {
        if (payloadKind === 'pdf') {
            throw new Error(
                `L'imprimante « ${device.host} » attend un flux ${protocol.toUpperCase()} mais a reçu un PDF. ` +
                'Vérifiez son type dans la liste des imprimantes (elle imprimerait des pages illisibles).',
            );
        }
        await printEscpos(device, bytes);
        return;
    }

    if (protocol === 'ipp') {
        if (payloadKind !== 'pdf') {
            throw new Error(
                `L'imprimante « ${device.host} » est en IPP mais a reçu un flux ${payloadKind.toUpperCase()}. ` +
                'Vérifiez son type dans la liste des imprimantes.',
            );
        }
        await printPdf(device, bytes, fileName || 'document.pdf', printOptions);
        return;
    }

    throw new Error(`Protocole d'impression inconnu « ${protocol} » : travail refusé plutôt qu'imprimé au hasard.`);
}

/** Récupère le contenu d'un travail réservé. */
async function fetchPayload(jobId: string): Promise<Buffer> {
    const res = await backendFetch(`/api/network-agent/jobs/${jobId}/payload`, { headers: authHeaders() }, TRANSFER_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Contenu du travail indisponible (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Prolonge la réservation d'un travail tant qu'il dure. Un scan avec chargeur automatique dépasse
 * facilement la durée de réservation : sans ce signal, le serveur croirait l'agent disparu et
 * remettrait le travail en file — le document serait scanné deux fois.
 */
function keepJobAlive(jobId: string): () => void {
    const timer = setInterval(() => {
        void backendFetch(`/api/network-agent/jobs/${jobId}/heartbeat`, {
            method: 'POST', headers: authHeaders(),
        }, 15_000).catch(() => undefined);
    }, 45000);
    return () => clearInterval(timer);
}

/**
 * Étiquette lisible d'un appareil pour les journaux : « Zebra Packing 1 (192.168.0.226:9100) ».
 *
 * Les échecs ne nommaient ni le travail ni la machine visée : le journal disait « travail échoué :
 * Timeout IPP » sans dire laquelle des six imprimantes du site avait bloqué, et il fallait sonder
 * le parc à la main pour le deviner.
 */
function deviceLabel(device?: AgentDevice): string {
    if (!device) return 'appareil inconnu';
    return `${device.name || device.host || 'appareil'} (${device.host}:${device.port})`;
}

/** Traite un travail réservé dans la file (protocole 2). */
async function runJob(job: any): Promise<void> {
    const device = job.device as AgentDevice;
    if (!device) {
        console.error(`[agent] travail ${job.jobId} refusé : appareil introuvable côté serveur.`);
        await postJobStatus(job.jobId, 'error', 'Appareil introuvable côté serveur');
        return;
    }
    const stopKeepAlive = keepJobAlive(job.jobId);
    try {
        if (job.type === 'scan') {
            const protocol = device?.capabilities?.['protocol'];
            const result = protocol === 'wsd'
                ? await scanWsd(device, job.scanSettings || {})
                : await scanEscl(device, job.scanSettings || {});
            await postScanResult(job.jobId, result.buffer, result.mime, result.fileName);
            return;
        }
        const bytes = await fetchPayload(job.jobId);
        await sendToPrinter(device, String(job.payloadKind || 'pdf'), bytes, job.fileName, job.printOptions || {});
        await postJobStatus(job.jobId, 'done');
        console.log(`[agent] travail ${job.jobId} terminé sur ${deviceLabel(device)}.`);
    } catch (e) {
        console.error(`[agent] travail ${job.jobId} échoué sur ${deviceLabel(device)} : ${(e as Error).message}`);
        await postJobStatus(job.jobId, 'error', (e as Error).message);
    } finally {
        stopKeepAlive();
    }
}

/**
 * Drain en cours, partagé entre appelants. Un `print` qui arrive pendant un drain doit obtenir le
 * VRAI résultat : avec un simple verrou booléen, il recevait « la file va bien » et son contenu
 * était jeté sans être imprimé ni signalé (constaté au banc d'essai contre un backend antérieur).
 */
let drainPromise: Promise<boolean> | null = null;
/** Heure de départ de la passe en cours — sert au chien de garde ci-dessous. */
let drainStartedAt = 0;
/**
 * Au-delà de cette durée, une passe de dépilement est considérée perdue.
 *
 * Généreux à dessein : un scan de chargeur bien rempli dure plusieurs minutes, et déclarer perdue
 * une passe qui travaille encore ferait imprimer deux fois. Les bornes de temps sur chaque appel
 * réseau font le gros du travail ; ce chien de garde n'est là que pour ce qu'elles ne couvrent
 * pas (une passe qui n'aboutit pas pour une raison qu'on n'a pas prévue).
 */
const DRAIN_WATCHDOG_MS = 15 * 60_000;
/**
 * Le backend expose-t-il la file d'attente ? Tant qu'il n'a pas été déployé, il pousse encore les
 * travaux complets dans le flux temps réel : l'agent doit alors les traiter à l'ancienne, sinon
 * plus rien ne s'imprime sur le site le temps que les deux versions se rejoignent.
 */
let queueAvailable = true;

/**
 * Vide la file du site, un travail à la fois.
 *
 * Le traitement est volontairement **séquentiel** : l'ancien agent lançait chaque travail sans
 * attendre le précédent, alors qu'une imprimante en port brut n'accepte qu'une connexion à la
 * fois. Un réveil arrivé pendant un traitement rejoint le drain en cours au lieu d'en lancer un
 * second — et en obtient le vrai résultat.
 */
async function drainJobs(): Promise<boolean> {
    // Backend sans file : inutile de redemander, on sait déjà qu'il faut traiter le contenu poussé.
    if (!queueAvailable) return false;
    if (drainPromise) {
        if (Date.now() - drainStartedAt < DRAIN_WATCHDOG_MS) return drainPromise;
        // Passe qui ne se termine plus : on la laisse tomber et on en relance une propre. Sans ce
        // garde-fou, une seule passe bloquée gelait le dépilement pour toute la vie du process —
        // seul un redémarrage de l'add-on remettait le site à imprimer.
        const minutes = Math.round((Date.now() - drainStartedAt) / 60_000);
        console.error(`[agent] dépilement bloqué depuis ${minutes} min : on repart sur une passe neuve.`);
        drainPromise = null;
    }
    drainStartedAt = Date.now();
    const started = runDrain().finally(() => { if (drainPromise === started) drainPromise = null; });
    drainPromise = started;
    return started;
}

/** Boucle de traitement : réserve et traite les travaux tant qu'il y en a. */
async function runDrain(): Promise<boolean> {
    try {
        for (;;) {
            const res = await backendFetch('/api/network-agent/jobs/next', { headers: authHeaders() });
            if (res.status === 404 || res.status === 501) {
                // Backend antérieur à la file d'attente : on repasse au traitement des événements
                // poussés. Sans ce repli, l'agent ignorerait le document reçu et le site
                // n'imprimerait plus rien jusqu'au déploiement du backend.
                if (queueAvailable) console.log('[agent] backend sans file d\'attente : traitement des travaux poussés.');
                queueAvailable = false;
                return false;
            }
            if (!res.ok) {
                console.error(`[agent] file inaccessible (HTTP ${res.status}).`);
                return true;
            }
            queueAvailable = true;
            const job = await res.json().catch(() => null);
            if (!job?.jobId) return true;
            await runJob(job);
        }
    } catch (e) {
        console.error('[agent] traitement de la file échoué :', (e as Error).message);
        return true;
    }
}

/**
 * Traitement d'un travail **poussé** par un backend antérieur à la file d'attente : le contenu est
 * embarqué dans l'événement (base64) au lieu d'être récupéré séparément. Chemin de compatibilité
 * uniquement — il disparaîtra quand tous les sites auront un backend à jour.
 */
async function runPushedJob(event: any): Promise<void> {
    const device = event.device as AgentDevice;
    if (!device || !event.jobId) return;
    try {
        if (event.type === 'scan') {
            const protocol = device?.capabilities?.['protocol'];
            const result = protocol === 'wsd'
                ? await scanWsd(device, event.scanSettings || {})
                : await scanEscl(device, event.scanSettings || {});
            await postScanResult(event.jobId, result.buffer, result.mime, result.fileName);
            return;
        }
        const [kind, base64] = event.escposBase64
            ? ['escpos', event.escposBase64]
            : event.rawBase64
                ? ['zpl', event.rawBase64]
                : ['pdf', event.pdfBase64];
        await sendToPrinter(device, kind, Buffer.from(String(base64 || ''), 'base64'),
            event.fileName, event.printOptions || {});
        await postJobStatus(event.jobId, 'done');
        console.log(`[agent] travail poussé ${event.jobId} terminé.`);
    } catch (e) {
        console.error('[agent] travail poussé échoué :', (e as Error).message);
        await postJobStatus(event.jobId, 'error', (e as Error).message);
    }
}

/**
 * Sonde une imprimante par IP : ports ouverts, identité, et langage réellement compris.
 * L'ancienne version ne testait que l'IPP sur 631 — une imprimante en port brut ne remontait rien,
 * ou remontait « IPP » à tort, ce qui lui faisait imprimer la requête HTTP en toutes lettres.
 */
async function handleProbe(job: any): Promise<void> {
    const host = String(job?.host || '').trim();
    if (!host) return;
    try {
        const device = await probePrinterCapabilities(host);
        if (device) {
            await postDevices([device]);
            const protocol = device.capabilities?.['protocol'];
            console.log(`[agent] sonde ${host} → ${device.mdnsName} (${protocol}, ports ${(device.capabilities?.['openPorts'] as number[] || []).join('/')})`);
        } else {
            console.log(`[agent] sonde ${host} : aucun port d'impression ouvert.`);
        }
    } catch (e) {
        console.error('[agent] sonde échec :', (e as Error).message);
    }
}

async function ping(): Promise<void> {
    try {
        await backendFetch(`/api/network-agent/ping?version=${AGENT_VERSION}&protocol=${PROTOCOL_VERSION}`, {
            method: 'POST',
            headers: authHeaders(),
        });
        console.log('[agent] ping ↔ pong OK.');
    } catch (e) {
        console.error('[agent] ping échec :', (e as Error).message);
    }
}

/** Événements du flux temps réel : ce sont des signaux, plus des travaux. */
async function handleEvent(event: any): Promise<void> {
    switch (event?.type) {
        case 'ping': await ping(); break;
        case 'discover': await discover({ snmpCommunity: event?.snmpCommunity }); break;
        case 'probe': await handleProbe(event); break;
        // Réveil : un travail attend dans la file.
        case 'wake':
            await drainJobs();
            break;
        // Événement complet d'un backend antérieur : on tente d'abord la file (backend à jour),
        // et à défaut on traite le contenu embarqué dans l'événement.
        case 'print':
        case 'scan':
            if (!(await drainJobs())) await runPushedJob(event);
            break;
        default: console.log('[agent] événement inconnu :', event);
    }
}

/** Lit un flux SSE via fetch streaming (sans dépendance). */
async function connectSse(): Promise<void> {
    const url = `${BACKEND_URL}/api/network-agent/sse?version=${AGENT_VERSION}&protocol=${PROTOCOL_VERSION}`;
    console.log('[agent] connexion SSE…');
    const res = await fetch(url, { headers: authHeaders({ Accept: 'text/event-stream' }) });
    if (!res.ok || !res.body) {
        // Remonte le message du backend (ex: « Token d'appairage invalide ») pour un diagnostic
        // immédiat des problèmes d'appairage, plutôt qu'un simple « HTTP 401 ».
        const reason = await res.text().catch(() => '');
        throw new Error(`SSE HTTP ${res.status}${reason ? ` — ${reason.slice(0, 200)}` : ''}`);
    }
    console.log(`[agent] connecté au backend (agent ${AGENT_VERSION}, protocole ${PROTOCOL_VERSION}).`);

    // Découverte initiale, puis rattrapage des travaux laissés en attente pendant la coupure.
    void discover();
    void drainJobs();

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as any) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const data = dataLine.slice(5).trim();
            if (!data) continue;
            try {
                void handleEvent(JSON.parse(data));
            } catch {
                /* keep-alive ou payload non-JSON : ignoré */
            }
        }
    }
}

/**
 * Arrêt propre.
 *
 * Sans écouteur, le conteneur sortait **systématiquement en code 137** : Docker envoyait SIGTERM,
 * personne ne l'écoutait, et le noyau tuait le process dix secondes plus tard. Un travail en cours
 * partait avec, sans statut : côté serveur il restait « en cours » jusqu'à expiration de son bail.
 * On laisse donc une courte fenêtre à la passe en cours pour se terminer et poster son résultat.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (drainPromise) {
        console.log(`[agent] ${signal} reçu — un travail est en cours, on lui laisse 5 s pour finir.`);
        await Promise.race([drainPromise, new Promise((r) => setTimeout(r, 5_000))]);
    } else {
        console.log(`[agent] ${signal} reçu — arrêt.`);
    }
    process.exit(0);
}

async function main(): Promise<void> {
    console.log(`[agent] MyStock network agent ${AGENT_VERSION} — backend ${BACKEND_URL}`);
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    // Filet : même sans réveil (flux coupé, événement perdu), la file finit par être traitée.
    setInterval(() => { void drainJobs(); }, POLL_MS);

    for (;;) {
        try {
            await connectSse();
        } catch (e) {
            console.error('[agent] SSE erreur :', (e as Error).message);
        }
        console.log(`[agent] reconnexion dans ${RECONNECT_MS / 1000}s…`);
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
}

void main();
