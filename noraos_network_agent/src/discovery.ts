import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';

import { Bonjour } from 'bonjour-service';

import { DiscoveredDevice } from './types';

const RAW_PRINT_PORT = 9100;

const WS_DISCOVERY_ADDR = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;

/**
 * Découverte mDNS des imprimantes IPP (`_ipp._tcp`/`_ipps._tcp`) et des scanners eSCL/AirScan
 * (`_uscan._tcp`/`_uscans._tcp`).
 */
function discoverMdns(durationMs: number): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
        const bonjour = new Bonjour();
        const found = new Map<string, DiscoveredDevice>();

        const browse = (type: string, secure: boolean, kind: 'printer' | 'scanner', protocol: string) => {
            bonjour.find({ type }, (service: any) => {
                const host = (service.addresses || []).find((a: string) => a.includes('.')) || service.host;
                if (!host) return;
                const port = service.port;
                const txt = service.txt || {};
                const esclPath = txt.rs ? `/${String(txt.rs).replace(/^\//, '')}` : '/eSCL';
                const key = `${kind}:${host}:${port}`;
                if (found.has(key)) return;
                found.set(key, {
                    kind,
                    mdnsName: service.name,
                    host,
                    port,
                    uuid: txt.UUID || txt.uuid || `${host}:${port}`,
                    txt,
                    capabilities: {
                        protocol,
                        secure,
                        ...(protocol === 'escl' ? { esclPath, esclBase: `${secure ? 'https' : 'http'}://${host}:${port}${esclPath}` } : {}),
                        ...(protocol === 'ipp' ? { ippUri: `${secure ? 'ipps' : 'ipp'}://${host}:${port}/${String(txt.rp || 'ipp/print').replace(/^\//, '')}` } : {}),
                        // Raw socket (JetDirect 9100) : imprimantes thermiques Zebra & co (ZPL/EPL/ESC-POS).
                        ...(protocol === 'socket' ? { socketPort: port || RAW_PRINT_PORT, raw: true } : {}),
                    },
                });
            });
        };

        browse('ipp', false, 'printer', 'ipp');
        browse('ipps', true, 'printer', 'ipp');
        browse('uscan', false, 'scanner', 'escl');
        browse('uscans', true, 'scanner', 'escl');
        // Imprimantes raw 9100 (Zebra thermiques & autres JetDirect) annoncées en mDNS.
        browse('pdl-datastream', false, 'printer', 'socket');

        setTimeout(() => {
            try { bonjour.destroy(); } catch {/* noop */}
            resolve([...found.values()]);
        }, durationMs);
    });
}

/**
 * Découverte WS-Discovery (UDP 3702 multicast) des scanners WSD / WS-Scan (Brother & co).
 * On envoie un Probe SOAP, on collecte les ProbeMatches qui annoncent le type ScanDeviceType
 * et on construit l'URL du service scanner par convention (`/WebServices/ScannerService`).
 */
function discoverWsd(durationMs: number): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
        const found = new Map<string, DiscoveredDevice>();
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const msgId = `urn:uuid:${cryptoRandomUuid()}`;
        const probe =
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ' +
            'xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
            'xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
            'xmlns:wscn="http://schemas.microsoft.com/windows/2006/08/wdp/scan">' +
            '<soap:Header>' +
            '<wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>' +
            '<wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>' +
            `<wsa:MessageID>${msgId}</wsa:MessageID>` +
            '</soap:Header>' +
            '<soap:Body><wsd:Probe><wsd:Types>wscn:ScanDeviceType</wsd:Types></wsd:Probe></soap:Body>' +
            '</soap:Envelope>';

        socket.on('message', (msg) => {
            const xml = msg.toString('utf8');
            if (!/ProbeMatch/i.test(xml) || !/Scan/i.test(xml)) return;
            const xaddr = (xml.match(/<[^>]*XAddrs[^>]*>([^<]+)</i) || [])[1]?.trim();
            const host = xaddr ? hostFromUrl(xaddr) : undefined;
            if (!host) return;
            const key = `scanner:${host}`;
            if (found.has(key)) return;
            // UUID stable du device : <wsa:EndpointReference><wsa:Address> à l'intérieur du
            // <wsd:ProbeMatch>. NE PAS prendre le premier urn:uuid du XML : c'est le
            // <wsa:MessageID> de la réponse, régénéré à chaque probe → provoquait la
            // création d'un nouveau document networkdevices par découverte (147k lignes
            // pour 11 scanners réels en prod). Fallback = host (stable par LAN).
            const probeMatch = (xml.match(/<[^>]*ProbeMatch[^>]*>([\s\S]*?)<\/[^>]*ProbeMatch>/i) || [])[1] || '';
            const endpointAddr = (probeMatch.match(/<[^>]*Address[^>]*>\s*(urn:uuid:[0-9a-f-]+)/i) || [])[1];
            found.set(key, {
                kind: 'scanner',
                mdnsName: `WSD ${host}`,
                host,
                port: 80,
                uuid: endpointAddr || host,
                txt: {},
                capabilities: { protocol: 'wsd', wsdUrl: `http://${host}/WebServices/ScannerService` },
            });
        });

        socket.on('error', () => {/* réseau indisponible */});
        socket.bind(() => {
            try {
                socket.setBroadcast(true);
                socket.send(Buffer.from(probe), WS_DISCOVERY_PORT, WS_DISCOVERY_ADDR);
            } catch {/* noop */}
        });

        setTimeout(() => {
            try { socket.close(); } catch {/* noop */}
            resolve([...found.values()]);
        }, durationMs);
    });
}

function hostFromUrl(url: string): string | undefined {
    try { return new URL(url).hostname; } catch { return undefined; }
}

function cryptoRandomUuid(): string {
    // Node 20+ : crypto.randomUUID global
    return (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Teste l'ouverture du port `port` sur `host` (connexion TCP brève). */
function tcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch {/* noop */}
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        try { socket.connect(port, host); } catch { finish(false); }
    });
}

/** Préfixes /24 des interfaces IPv4 locales (ex: "192.168.1"). */
function localSubnets(): string[] {
    const prefixes = new Set<string>();
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                prefixes.add(a.address.split('.').slice(0, 3).join('.'));
            }
        }
    }
    return [...prefixes];
}

/**
 * Balayage du port 9100 (raw/JetDirect) sur les sous-réseaux /24 locaux. Détecte les imprimantes
 * thermiques (Zebra 203dpi, etc.) qui n'annoncent ni IPP ni mDNS. Concurrence plafonnée.
 */
async function discoverRaw9100(timeoutMs = 600): Promise<DiscoveredDevice[]> {
    const subnets = localSubnets();
    if (!subnets.length) return [];
    const hosts: string[] = [];
    for (const prefix of subnets) {
        for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
    }

    const found: DiscoveredDevice[] = [];
    const CONCURRENCY = 64;
    let cursor = 0;
    const worker = async () => {
        while (cursor < hosts.length) {
            const host = hosts[cursor++];
            if (await tcpPortOpen(host, RAW_PRINT_PORT, timeoutMs)) {
                found.push({
                    kind: 'printer',
                    mdnsName: `Imprimante réseau ${host}`,
                    host,
                    port: RAW_PRINT_PORT,
                    uuid: `socket:${host}:${RAW_PRINT_PORT}`,
                    txt: {},
                    capabilities: { protocol: 'socket', socketPort: RAW_PRINT_PORT, raw: true },
                });
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return found;
}

/** Découverte complète : IPP + eSCL (mDNS) + WSD (WS-Discovery) + raw 9100 (Zebra/JetDirect). */
export async function discoverAll(durationMs = 4000): Promise<DiscoveredDevice[]> {
    const [mdns, wsd, raw] = await Promise.all([
        discoverMdns(durationMs),
        discoverWsd(durationMs),
        discoverRaw9100(),
    ]);
    // Dédup par host+kind. Priorité au protocole le plus riche : ipp/escl > socket > wsd.
    const rank = (p?: unknown): number => (p === 'ipp' || p === 'escl' ? 3 : p === 'socket' ? 2 : 1);
    const byKey = new Map<string, DiscoveredDevice>();
    for (const d of [...mdns, ...wsd, ...raw]) {
        const key = `${d.kind}:${d.host}`;
        const existing = byKey.get(key);
        if (!existing || rank(d.capabilities?.protocol) > rank(existing.capabilities?.protocol)) {
            byKey.set(key, d);
        }
    }
    return [...byKey.values()];
}
