import { AgentDevice, ScanResult } from './types';
import { jpegPagesToPdf } from './pages-to-pdf';

/**
 * Scan WSD / WS-Scan (MS-WSDScan) pour les scanners Brother & compatibles Windows.
 * Repris de l'approche de gabest11/homeassistant-brother_scanner :
 *   1. CreateScanJob  → JobId + JobToken
 *   2. RetrieveImage  → réponse MTOM (multipart/related) contenant le JPEG
 * SOAP/XML sur HTTP (port 80), service `http://{ip}/WebServices/ScannerService`.
 *
 * NB : les tickets WS-Scan varient légèrement selon les constructeurs ; ce client cible les
 * réglages standards (Platen, JPEG/exif, 300 dpi, couleur). À valider sur le matériel réel.
 */

const WSCN = 'http://schemas.microsoft.com/windows/2006/08/wdp/scan';
const WSA = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';
const SOAP = 'http://www.w3.org/2003/05/soap-envelope';

function wsdUrl(device: AgentDevice): string {
    const u = device.capabilities?.['wsdUrl'];
    if (typeof u === 'string' && u) return u;
    return `http://${device.host}/WebServices/ScannerService`;
}

function uuid(): string {
    return (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function envelope(to: string, action: string, body: string): string {
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<soap:Envelope xmlns:soap="${SOAP}" xmlns:wsa="${WSA}" xmlns:wscn="${WSCN}">` +
        `<soap:Header>` +
        `<wsa:To>${to}</wsa:To>` +
        `<wsa:Action>${action}</wsa:Action>` +
        `<wsa:MessageID>urn:uuid:${uuid()}</wsa:MessageID>` +
        `<wsa:ReplyTo><wsa:Address>${WSA}/role/anonymous</wsa:Address></wsa:ReplyTo>` +
        `</soap:Header>` +
        `<soap:Body>${body}</soap:Body>` +
        `</soap:Envelope>`
    );
}

async function soapCall(to: string, action: string, body: string): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
    const res = await fetch(to, {
        method: 'POST',
        headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` },
        body: envelope(to, action, body),
    });
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

function createScanJobBody(settings: Record<string, unknown>): string {
    const source = String(settings['source']) === 'adf' ? 'ADF' : 'Platen';
    const resolution = Number(settings['resolution']) || 300;
    const color = (settings['colorMode'] as string) || 'RGB24';
    return (
        `<wscn:CreateScanJobRequest>` +
        `<wscn:ScanTicket>` +
        `<wscn:JobDescription>` +
        `<wscn:JobName>MyStock</wscn:JobName>` +
        `<wscn:JobOriginatingUserName>mystock</wscn:JobOriginatingUserName>` +
        `</wscn:JobDescription>` +
        `<wscn:DocumentParameters>` +
        `<wscn:Format>exif</wscn:Format>` +
        `<wscn:InputSource>${source}</wscn:InputSource>` +
        `<wscn:InputSize><wscn:DocumentSizeAutoDetect/></wscn:InputSize>` +
        `<wscn:MediaSides>` +
        `<wscn:MediaFront>` +
        `<wscn:ColorProcessing>${color}</wscn:ColorProcessing>` +
        `<wscn:Resolution><wscn:Width>${resolution}</wscn:Width><wscn:Height>${resolution}</wscn:Height></wscn:Resolution>` +
        `</wscn:MediaFront>` +
        `</wscn:MediaSides>` +
        `</wscn:DocumentParameters>` +
        `</wscn:ScanTicket>` +
        `</wscn:CreateScanJobRequest>`
    );
}

function pick(xml: string, tag: string): string | undefined {
    const m = xml.match(new RegExp(`<[^>]*${tag}[^>]*>([^<]+)</[^>]*${tag}>`, 'i'));
    return m?.[1]?.trim();
}

/** Extrait la partie image d'une réponse MTOM (multipart/related). */
function extractMtomImage(contentType: string, body: Buffer): Buffer | null {
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
    if (!boundaryMatch) {
        // Pas de multipart : peut-être l'image brute
        return body.length > 1000 ? body : null;
    }
    const boundary = Buffer.from(`--${boundaryMatch[1]}`);
    const parts: Buffer[] = [];
    let start = body.indexOf(boundary);
    while (start !== -1) {
        const next = body.indexOf(boundary, start + boundary.length);
        if (next === -1) break;
        parts.push(body.subarray(start + boundary.length, next));
        start = next;
    }
    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.subarray(0, headerEnd).toString('latin1');
        if (/image\/(jpeg|png)/i.test(headers) || /Content-Transfer-Encoding:\s*binary/i.test(headers)) {
            // Retire le CRLF de fin avant le prochain boundary
            let content = part.subarray(headerEnd + 4);
            if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2);
            return content;
        }
    }
    return null;
}

/**
 * Scan WSD complet → PDF. Une seule CreateScanJob, puis on boucle RetrieveImage : chaque appel
 * renvoie une page (MTOM JPEG). Pour l'ADF, on récupère ainsi TOUTES les pages du chargeur
 * jusqu'à la fin (fault SOAP / plus d'image), puis on assemble en un seul PDF.
 */
export async function scanWsd(device: AgentDevice, settings: Record<string, unknown>): Promise<ScanResult> {
    const url = wsdUrl(device);

    const created = await soapCall(url, `${WSCN}/CreateScanJob`, createScanJobBody(settings));
    if (created.status !== 200) throw new Error(`WSD CreateScanJob HTTP ${created.status}`);
    const createdXml = created.buffer.toString('utf8');
    const jobId = pick(createdXml, 'JobId');
    const jobToken = pick(createdXml, 'JobToken');
    if (!jobId || !jobToken) throw new Error('WSD : JobId/JobToken manquants');

    const pages: Buffer[] = [];
    for (let i = 0; i < 200; i++) {
        const retrieveBody =
            `<wscn:RetrieveImageRequest>` +
            `<wscn:JobId>${jobId}</wscn:JobId>` +
            `<wscn:JobToken>${jobToken}</wscn:JobToken>` +
            `<wscn:DocumentDescription><wscn:DocumentName>scan-${i + 1}</wscn:DocumentName></wscn:DocumentDescription>` +
            `</wscn:RetrieveImageRequest>`;
        const image = await soapCall(url, `${WSCN}/RetrieveImage`, retrieveBody);
        if (image.status !== 200) break; // fault (plus de page dans le chargeur) → fin
        const jpeg = extractMtomImage(image.headers.get('content-type') || '', image.buffer);
        if (!jpeg) break;
        pages.push(jpeg);
    }
    if (!pages.length) throw new Error('WSD : aucune image récupérée');

    const pdf = await jpegPagesToPdf(pages);
    return { buffer: pdf, mime: 'application/pdf', fileName: `scan-${Date.now()}.pdf` };
}
