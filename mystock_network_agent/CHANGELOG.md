# Changelog — NoraOS Network Agent

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
