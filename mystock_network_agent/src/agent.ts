/**
 * Agent local MyStock — Phase 1.
 *
 * Déployé sur le LAN d'un site, il ouvre une connexion SSE SORTANTE vers le backend MyStock
 * (NAT-friendly), reçoit des jobs (discover/print/scan) et POST les résultats.
 *   - découverte : mDNS (imprimantes IPP, scanners eSCL) + WS-Discovery (scanners WSD/Brother) ;
 *   - impression : IPP (Print-Job) ;
 *   - scan : eSCL (AirScan) ou WSD (WS-Scan) selon le protocole de l'appareil.
 *
 * Config par variables d'environnement :
 *   BACKEND_URL    ex: https://client.my-stock.fr
 *   PAIRING_TOKEN  token d'appairage du site (généré dans MyStock)
 */

import * as fs from 'fs';

import { discoverAll } from './discovery';
import { probeIpp } from './probe';
import { printPdf } from './print-ipp';
import { printEscpos } from './print-escpos';
import { scanEscl } from './scan-escl';
import { scanWsd } from './scan-wsd';
import { AgentDevice } from './types';

/**
 * Config : variables d'environnement (déploiement Docker standalone) OU options de l'add-on
 * Home Assistant (`/data/options.json` : backend_url / pairing_token).
 */
function loadConfig(): { backendUrl: string; token: string } {
    let backendUrl = process.env.BACKEND_URL || '';
    let token = process.env.PAIRING_TOKEN || '';
    if (!backendUrl || !token) {
        try {
            const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
            backendUrl = backendUrl || opts.backend_url || '';
            token = token || opts.pairing_token || '';
        } catch {/* pas en add-on HA */}
    }
    return { backendUrl: backendUrl.replace(/\/+$/, ''), token };
}

const { backendUrl: BACKEND_URL, token: TOKEN } = loadConfig();
const RECONNECT_MS = 3000;
const DISCOVERY_MS = Number(process.env.DISCOVERY_MS) || 4000;

if (!BACKEND_URL || !TOKEN) {
    console.error('[agent] BACKEND_URL et PAIRING_TOKEN sont requis.');
    process.exit(1);
}

async function postDevices(devices: unknown[]): Promise<void> {
    try {
        await fetch(`${BACKEND_URL}/api/network-agent/devices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ devices }),
        });
        console.log(`[agent] ${devices.length} appareil(s) remonté(s).`);
    } catch (e) {
        console.error('[agent] POST /devices échec :', (e as Error).message);
    }
}

async function postJobStatus(jobId: string, status: 'done' | 'error', error?: string): Promise<void> {
    try {
        await fetch(`${BACKEND_URL}/api/network-agent/jobs/${jobId}/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
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
        await fetch(`${BACKEND_URL}/api/network-agent/jobs/${jobId}/result`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: fd,
        });
        console.log(`[agent] scan ${jobId} envoyé (${buffer.length} octets).`);
    } catch (e) {
        console.error('[agent] POST scan result échec :', (e as Error).message);
        await postJobStatus(jobId, 'error', (e as Error).message);
    }
}

async function discover(): Promise<void> {
    try {
        const devices = await discoverAll(DISCOVERY_MS);
        await postDevices(devices);
    } catch (e) {
        console.error('[agent] découverte échec :', (e as Error).message);
    }
}

async function handlePrint(job: any): Promise<void> {
    const device = job.device as AgentDevice;
    const protocol = device?.capabilities?.['protocol'];
    try {
        if (protocol === 'escpos') {
            // Imprimante à ticket thermique : le backend a déjà construit le flux ESC/POS
            // (init + image raster + coupe) ; on l'écrit tel quel sur la socket brute (port 9100).
            const bytes = Buffer.from(String(job.escposBase64 || ''), 'base64');
            if (!bytes.length) throw new Error('Flux ESC/POS vide (escposBase64 manquant)');
            await printEscpos(device, bytes);
        } else if (protocol === 'zpl' || protocol === 'raw') {
            // Imprimante Zebra (ZPL) / raw : le backend a déjà construit le flux (bitmap ZPL ^GFA).
            // On l'écrit tel quel sur la socket brute (port 9100) — même chemin que l'ESC/POS.
            const bytes = Buffer.from(String(job.rawBase64 || ''), 'base64');
            if (!bytes.length) throw new Error('Flux ZPL/raw vide (rawBase64 manquant)');
            await printEscpos(device, bytes);
        } else {
            const pdf = Buffer.from(String(job.pdfBase64 || ''), 'base64');
            await printPdf(device, pdf, job.fileName || 'document.pdf', job.printOptions || {});
        }
        await postJobStatus(job.jobId, 'done');
        console.log(`[agent] impression ${job.jobId} OK.`);
    } catch (e) {
        console.error('[agent] impression échec :', (e as Error).message);
        await postJobStatus(job.jobId, 'error', (e as Error).message);
    }
}

async function handleScan(job: any): Promise<void> {
    const device = job.device as AgentDevice;
    const protocol = device?.capabilities?.['protocol'];
    try {
        const result = protocol === 'wsd'
            ? await scanWsd(device, job.scanSettings || {})
            : await scanEscl(device, job.scanSettings || {});
        await postScanResult(job.jobId, result.buffer, result.mime, result.fileName);
    } catch (e) {
        console.error('[agent] scan échec :', (e as Error).message);
        await postJobStatus(job.jobId, 'error', (e as Error).message);
    }
}

/** Sonde une imprimante par IP (« forcer la recherche ») et la remonte si elle répond. */
async function handleProbe(job: any): Promise<void> {
    const host = String(job?.host || '').trim();
    if (!host) return;
    const port = Number(job?.port) > 0 ? Number(job.port) : 631;
    try {
        const device = await probeIpp(host, port);
        if (device) {
            await postDevices([device]);
            console.log(`[agent] probe ${host}:${port} → ${device.mdnsName}`);
        } else {
            console.log(`[agent] probe ${host}:${port} : aucune réponse IPP.`);
        }
    } catch (e) {
        console.error('[agent] probe échec :', (e as Error).message);
    }
}

async function ping(): Promise<void> {
    try {
        await fetch(`${BACKEND_URL}/api/network-agent/ping`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        console.log('[agent] ping ↔ pong OK.');
    } catch (e) {
        console.error('[agent] ping échec :', (e as Error).message);
    }
}

async function handleJob(job: any): Promise<void> {
    switch (job?.type) {
        case 'ping': await ping(); break;
        case 'discover': await discover(); break;
        case 'probe': await handleProbe(job); break;
        case 'print': await handlePrint(job); break;
        case 'scan': await handleScan(job); break;
        default: console.log('[agent] event inconnu :', job);
    }
}

/** Lit un flux SSE via fetch streaming (sans dépendance). */
async function connectSse(): Promise<void> {
    const url = `${BACKEND_URL}/api/network-agent/sse?token=${encodeURIComponent(TOKEN)}`;
    console.log('[agent] connexion SSE…');
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
    if (!res.ok || !res.body) {
        // Remonte le message du backend (ex: « Token d'appairage invalide ») pour un diagnostic
        // immédiat des problèmes d'appairage, plutôt qu'un simple « HTTP 401 ».
        const reason = await res.text().catch(() => '');
        throw new Error(`SSE HTTP ${res.status}${reason ? ` — ${reason.slice(0, 200)}` : ''}`);
    }
    console.log('[agent] connecté au backend.');

    // Découverte initiale dès la connexion.
    void discover();

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
                void handleJob(JSON.parse(data));
            } catch {
                /* keep-alive ou payload non-JSON : ignoré */
            }
        }
    }
}

async function main(): Promise<void> {
    console.log(`[agent] MyStock network agent — backend ${BACKEND_URL}`);
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
