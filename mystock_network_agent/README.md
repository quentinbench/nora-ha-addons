# NoraOS Network Agent — impression IPP & scan eSCL (agent réseau MyStock)

Petit service à déployer **sur le réseau local de chaque site** (bureaux, entrepôt). Il permet à
MyStock (hébergé à distance) de **découvrir**, **imprimer** et **scanner** sur des imprimantes et
scanners réseau, sans ouvrir aucun port entrant.

## Pourquoi un agent ?

Le backend MyStock est distant : il ne peut pas joindre directement les imprimantes (IPP) ni les
scanners (eSCL) de votre réseau local, et un navigateur ne parle pas ces protocoles. L'agent,
installé sur place, fait le pont :

- il **découvre** les imprimantes/scanners en mDNS ;
- il **imprime** les PDF générés par MyStock via IPP ;
- il **scanne** des documents via eSCL et renvoie le fichier à MyStock.

La connexion est **100 % sortante** : l'agent ouvre un flux SSE vers MyStock (comme un navigateur)
et y reçoit les jobs. Aucune redirection de port ni IP publique nécessaire.

## Installation — add-on Home Assistant (recommandé)

Si Home Assistant tourne chez vous (HA **OS** / **Supervised**), installez l'agent comme **add-on**
depuis le **dépôt d'add-ons NoraOS**. Il tourne sur la même machine que HA, sur le réseau local du site.

> ⚠️ **Add-on, pas HACS.** Le dépôt s'ajoute dans la **boutique de modules complémentaires**
> (Add-on Store), **pas dans HACS** (HACS ne gère pas les add-ons et refusera l'URL).

1. **Récupérer le token** dans MyStock : *Configurations → Impression / Scan réseau → Sites / Agents*
   → ajouter un site, **Enregistrer**, puis **« Générer les tokens d'appairage »** et copier le token.

2. HA → **Paramètres → Modules complémentaires → Boutique** → **⋮ → Dépôts** → coller l'URL du dépôt
   puis **Ajouter** :

   ```
   https://github.com/quentinbench/nora-ha-addons
   ```

3. Le dépôt **« NoraOS Add-ons »** apparaît ; l'add-on **« NoraOS Network Agent »** y est listé →
   **Installer** (HA build l'image Docker — quelques minutes).

4. Onglet **Configuration** de l'add-on :
   - `backend_url` : l'URL de votre instance MyStock (ex. `https://votre-instance.my-stock.fr`)
   - `pairing_token` : le token copié à l'étape 1
   Puis **Démarrer**, et activez **« Démarrer au démarrage »** + **« Mise à jour automatique »**.

5. Onglet **Journal (Log)** : vous devez voir `connecté au backend` puis les appareils découverts.
   Dans MyStock, le scanner Brother (et les imprimantes IPP) apparaissent → utilisables, avec le
   choix **Vitre / Chargeur (ADF)** sur les boutons de scan.

> L'add-on utilise `host_network: true` (nécessaire pour la découverte mDNS / WS-Discovery et
> l'accès direct aux imprimantes/scanners du LAN). Aucun port entrant n'est ouvert : l'agent ne
> fait que des connexions **sortantes** vers MyStock.
>
> _Publication : ce dépôt est alimenté automatiquement par `agent/release-addon.sh` depuis le
> monorepo (source de vérité). Ne pas éditer les fichiers du dépôt d'add-ons à la main._

## Installation — Docker standalone (hors HA OS)

1. Dans MyStock : **Configurations → Impression / Scan réseau** → ajouter un **site**, enregistrer,
   puis **« Générer les tokens d'appairage »** et copier le token du site.
2. Créer un fichier `.env` à côté de `docker-compose.agent.yml` :

   ```env
   BACKEND_URL=https://votre-instance.my-stock.fr
   PAIRING_TOKEN=le-token-copié
   ```

3. Lancer :

   ```bash
   docker compose -f docker-compose.agent.yml up -d --build
   ```

`network_mode: host` est requis pour la découverte mDNS et l'accès aux appareils du LAN.

## Développement

```bash
npm install
npm run dev      # ts-node
npm run build && npm start
```

Variables : `BACKEND_URL`, `PAIRING_TOKEN`.

## Capacités

- **Découverte** : mDNS (`bonjour-service`) pour les imprimantes IPP (`_ipp/_ipps`) et les scanners
  eSCL (`_uscan/_uscans`) ; WS-Discovery (UDP 3702) pour les scanners WSD (Brother & compatibles).
- **Impression** : IPP (`Print-Job`, PDF).
- **Scan** : eSCL **et** WSD/WS-Scan, avec **ADF multi-pages** (source Vitre ou Chargeur) —
  boucle sur toutes les pages du chargeur et assemblage en **un seul PDF** (`pdf-lib`).
- **Connexion** : SSE sortant vers MyStock (NAT-friendly), reconnexion automatique.

Config lue depuis les variables d'environnement (Docker) **ou** les options de l'add-on Home
Assistant (`/data/options.json`).
