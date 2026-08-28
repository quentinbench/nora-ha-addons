export type DeviceKind = 'printer' | 'scanner';
export type ScanProtocol = 'escl' | 'wsd';

export interface DiscoveredDevice {
    kind: DeviceKind;
    mdnsName?: string;
    host: string;
    port: number;
    uuid?: string;
    txt?: Record<string, unknown>;
    /** Détails techniques : { protocol, esclPath?, wsdUrl?, ... } */
    capabilities?: Record<string, unknown>;
}

/** Device tel que renvoyé par le backend dans un job (cf. deviceForAgent). */
export interface AgentDevice {
    id: string;
    kind: DeviceKind;
    host: string;
    port: number;
    uuid?: string;
    txt?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
}

export interface ScanResult {
    buffer: Buffer;
    mime: string;
    fileName: string;
}
