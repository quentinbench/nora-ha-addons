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
    /** Compteur de pages relevé en SNMP (imprimantes). */
    pageCount?: number;
    /** Ce que compte `pageCount` : faces imprimées, feuilles, ou autre (cf. prtMarkerCounterUnit). */
    pageCountUnit?: 'impressions' | 'sheets' | 'other';
    /** Niveaux de consommables relevés en SNMP (toner, tambour, four…). */
    supplies?: Array<{ name: string; kind: string; percent?: number; level?: number; maxCapacity?: number }>;
}

/** Device tel que renvoyé par le backend dans un job (cf. deviceForAgent). */
export interface AgentDevice {
    id: string;
    /** Nom donné à l'appareil dans MyStock. Absent tant que le backend du site n'est pas à jour. */
    name?: string;
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
