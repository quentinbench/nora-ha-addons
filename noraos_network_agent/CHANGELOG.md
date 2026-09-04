# Changelog — NoraOS Network Agent

## 0.4.3
- 🐛 **Travail poussé jeté pendant un traitement en cours** : quand un travail arrivait alors que
  l'agent interrogeait déjà la file, il recevait « la file va bien » et son contenu était abandonné
  sans être imprimé ni signalé. Un travail concurrent rejoint désormais le traitement en cours et en
  obtient le vrai résultat. Trouvé au banc d'essai, pas en production.

## 0.4.2
- 🔁 **Compatible avec un backend non encore mis à jour** : si le serveur n'expose pas encore la file
  d'attente, l'agent traite les travaux poussés dans le flux temps réel, comme avant. Sans ce repli,
  installer cet agent avant le déploiement du backend **arrêtait toute impression sur le site** (le
  document poussé était ignoré au profit d'une file inexistante). L'ordre de déploiement n'a donc plus
  d'importance, et un retour arrière du serveur ne casse plus le site.

## 0.4.1
- 🔎 **Sonde d'imprimante réelle** : au lieu de ne tester que l'IPP sur le port 631, l'agent teste les
  ports 631 / 9100 / 515, lit le modèle et les formats acceptés en IPP, et **demande à l'imprimante en
  port brut quel langage elle parle** (`~HI` pour ZPL/Zebra, `GS I` pour ESC/POS). Une imprimante
  ajoutée par son adresse IP se règle donc toute seule, au lieu d'être supposée « IPP ».
- 🚫 **Refus de l'IPP sur un port brut** : c'est la cause d'une panne constatée en production — une
  imprimante déclarée « IPP » sur le port 9100 recevait une requête HTTP que le port brut imprimait
  en toutes lettres (« POST /ipp/print HTTP/1.1 … ») au lieu du document.

## 0.4.0
- 📥 **L'agent va chercher son travail** (protocole 2). Les travaux étaient jusqu'ici *poussés* dans le
  flux temps réel : un travail lancé pendant une reconnexion, un redémarrage ou une coupure réseau
  était **perdu sans laisser de trace**, et restait « en cours » indéfiniment côté MyStock. Désormais le
  flux ne sert qu'à réveiller l'agent ; celui-ci réserve les travaux dans la file du serveur, récupère
  leur contenu, et **accuse réception**. Un travail non traité est repris automatiquement.
- 🚫 **Fin des impressions en double** : la réservation d'un travail est atomique côté serveur, et
  l'agent traite les travaux **un par un** (une imprimante en port brut 9100 n'accepte qu'une connexion
  à la fois — l'ancienne version les lançait tous en parallèle).
- 🧾 **Fin des pages de caractères illisibles** : un contenu qui ne correspond pas au type de
  l'imprimante (un PDF envoyé à une Zebra, un flux ZPL envoyé à une imprimante IPP) est **refusé avec un
  message clair** au lieu d'être imprimé au hasard. L'ancienne version retombait silencieusement sur
  l'impression IPP dès que le protocole n'était pas reconnu.
- 🔐 Le **jeton d'appairage passe en en-tête** HTTP au lieu de l'URL (il n'apparaît plus dans les
  journaux d'accès).
- 🩺 L'agent **annonce sa version** au serveur : une build restée en arrière devient visible dans
  MyStock, au lieu de se manifester par des impressions qui échouent sans raison apparente.

## 0.3.2
- 🏷️ **Slug renommé** `mystock_network_agent` → **`noraos_network_agent`** (rebranding NoraOS complet,
  dossier du dépôt inclus). ⚠️ Le slug étant l'identité de l'add-on côté HA, c'est un **nouvel add-on** :
  une installation issue de l'ancien slug devient orpheline → **réinstaller** « NoraOS Network Agent »
  depuis la boutique et ressaisir `backend_url` + `pairing_token`. L'ancien dossier est retiré du dépôt.

## 0.3.1
- 🏷️ **Renommage** : l'add-on s'appelle désormais **« NoraOS Network Agent »** (dépôt **« NoraOS Add-ons »**).
  Le slug interne (`mystock_network_agent`) est **inchangé** → mise à jour automatique préservée, aucune
  réinstallation ni ressaisie du token. La connexion reste vers votre instance **MyStock** (backend).
- 📖 **Documentation** : README du dépôt + doc de l'add-on clarifiés — installation via la **boutique de
  modules complémentaires** (Add-on Store), **pas via HACS** (HACS ne gère pas les add-ons).

## 0.3.0
- 🖨️ **Rastérisation PDF → PWG-Raster** en **opt-in par imprimante** (`capabilities.rasterize`).
  Certains lasers récents (ex. Brother **HL-L2445DW**) annoncent l'IPP/AirPrint mais **n'ont pas
  d'interpréteur PDF** : leur envoyer le PDF brut faisait sortir des **pages blanches** (job pourtant
  accepté → statut "done" trompeur). Pour un device marqué `rasterize: true`, l'agent rastérise le
  PDF (**mutool** / mupdf-tools) puis envoie `image/pwg-raster`. **Toutes les autres imprimantes
  gardent EXACTEMENT leur comportement actuel** (`application/pdf` → repli `application/octet-stream`)
  — aucune régression sur les modèles qui impriment déjà bien (HL-L2375DW, HL-L2350DW…). Validé de
  bout en bout sur une Brother HL-L2375DW réelle (PWG accepté + imprimé). — MYS-59
- 🐳 Image Docker : ajout de `mupdf-tools` (fournit `mutool`, nécessaire à la rastérisation).

> ⚠️ À activer par imprimante concernée en posant `rasterize: true` dans ses capabilities côté
> MyStock (fait pour le poste 4 / HL-L2445DW).

## 0.2.0
- 🦓 **Impression Zebra (ZPL)** sur le port brut 9100 (étiquettes transporteur).
- 🧾 **Impression tickets thermiques (ESC/POS)** 80 mm (port 9100).
- 📄 **Scan multi-pages** (recto/verso manuel) et amélioration eSCL/WSD.
- Robustesse : messages d'erreur plus précis, gestion des protocoles `zpl`/`raw`/`escpos`.

> ⚠️ Si vous étiez en 0.1.0, cette mise à jour est **nécessaire** pour imprimer sur les Zebra :
> l'ancienne version ne connaissait que l'IPP et échouait sur les étiquettes ZPL.

## 0.1.0
- Version initiale : impression **IPP** (imprimantes réseau) + scan **eSCL/WSD** (ADF multi-pages),
  reliée à MyStock via une connexion SSE sortante (token d'appairage par site).
