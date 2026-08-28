# NoraOS Add-ons pour Home Assistant

Dépôt d'**add-ons Home Assistant** de NoraOS / MyStock.

| Add-on | Rôle |
|--------|------|
| **NoraOS Network Agent** | Pont entre les **imprimantes** et **scanners** du réseau local et MyStock : impression **IPP / ZPL (Zebra) / ESC-POS (ticket)**, scan **eSCL / WSD** (chargeur ADF multi-pages). Connexion 100 % sortante (SSE) — aucun port entrant. |

---

## ⚠️ C'est un dépôt d'ADD-ON — PAS une intégration HACS

Ce dépôt s'ajoute dans la **boutique de modules complémentaires** (Add-on Store) de Home Assistant,
**pas dans HACS**.

Si vous essayez de l'ajouter dans **HACS → Dépôts personnalisés**, HACS le refusera avec ce message
(c'est normal) :

> The repository does not seem to be a integration, but an add-on repository.
> HACS does not manage add-ons.

Les add-ons ne se gèrent pas via HACS. Suivez l'installation ci-dessous.

> **Prérequis :** Home Assistant **OS** ou **Supervised**. La boutique d'add-ons n'existe pas sur
> Home Assistant **Container** ni **Core** — dans ce cas, utilisez le déploiement Docker autonome
> (voir la doc de l'add-on).

---

## Installation (en 5 étapes)

1. Home Assistant → **Paramètres → Modules complémentaires** *(Settings → Add-ons)*.
2. En bas à droite : **Boutique** *(Add-on Store)*.
3. En haut à droite **⋮ → Dépôts** *(Repositories)*.
4. Collez l'URL de ce dépôt, puis **Ajouter** :

   ```
   https://github.com/quentinbench/nora-ha-addons
   ```

5. Fermez la fenêtre. Le dépôt **NoraOS Add-ons** apparaît dans la boutique ; l'add-on
   **NoraOS Network Agent** y est listé → cliquez dessus → **Installer**
   *(Home Assistant construit l'image, quelques minutes)*.

## Configuration

Onglet **Configuration** de l'add-on :

| Option | Valeur |
|--------|--------|
| `backend_url` | L'URL de votre instance MyStock (ex. `https://app.my-stock.fr`). |
| `pairing_token` | Le token d'appairage du site, généré dans MyStock : **Configurations → Impression / Scan réseau → Sites / Agents → « Générer les tokens d'appairage »**. |

Puis **Démarrer** l'add-on et activez **« Démarrer au démarrage »** + **« Mise à jour automatique »**.

Onglet **Journal** *(Log)* : vous devez voir `connecté au backend`, puis les appareils découverts.
Ils apparaissent alors dans MyStock (imprimantes IPP, scanner Brother avec choix **Vitre / Chargeur ADF**…).

## Mises à jour

À chaque nouvelle version publiée ici, Home Assistant la détecte automatiquement (ou via
**⋮ → Rechercher des mises à jour** dans la boutique) et l'installe — **sans intervention sur site**
si « Mise à jour automatique » est activé.

## Réseau & sécurité

- L'add-on utilise `host_network: true` : nécessaire pour la découverte **mDNS / WS-Discovery** et
  l'accès direct aux imprimantes (IPP / port 9100) et scanners (eSCL / WSD) du LAN.
- La liaison vers MyStock est **100 % sortante** (SSE) : aucun port entrant ni IP publique.
- Le `pairing_token` est saisi **localement** dans la config de l'add-on ; il n'est **pas** stocké
  dans ce dépôt.

---

Mainteneur : **MyInfinity** &lt;quentin@my-infinity.eu&gt;.
La source de vérité du code est le monorepo MyStock (dossier `agent/`) ; ce dépôt est **publié
automatiquement** à chaque release — ne pas éditer ses fichiers à la main.
