# MyStock Network Agent — Add-on Home Assistant

Agent local qui relie les **imprimantes** et **scanners** du réseau local à MyStock :
impression **IPP** / **ZPL (Zebra)** / **ESC/POS (ticket)**, scan **eSCL/WSD** (chargeur ADF multi-pages).
Il ouvre une connexion **SSE sortante** vers MyStock (compatible NAT, aucun port à ouvrir) et
s'authentifie par un **token d'appairage** propre au site.

## Installation

1. Dans Home Assistant : **Paramètres → Modules complémentaires → Boutique**.
2. En haut à droite **⋮ → Dépôts**, ajoutez l'URL de ce dépôt, puis fermez.
3. Le module **« MyStock Network Agent »** apparaît dans la liste → **Installer**.
4. Onglet **Configuration**, renseignez :
   - `backend_url` : l'URL de votre instance MyStock (ex : `https://app.my-stock.fr`).
   - `pairing_token` : le token d'appairage généré dans MyStock
     (Configurations → Intégrations → Impression / Scan réseau).
5. **Démarrez** l'add-on et activez **« Lancer au démarrage »** + **« Mise à jour automatique »**.

## Mises à jour

Lorsque MyStock publie une nouvelle version de l'agent, Home Assistant la détecte
automatiquement (ou via **⋮ → Rechercher des mises à jour**) et l'installe — sans intervention
sur site si « Mise à jour automatique » est activé.

## Réseau

L'add-on utilise `host_network: true` : nécessaire pour la découverte mDNS / WS-Discovery et
l'accès direct aux imprimantes (IPP/9100) et scanners (eSCL/WSD) du LAN.
