# Nova

Lecteur musical iOS personnel qui lit le catalogue YouTube Music, avec une interface Liquid Glass (iOS 26 et plus).

## Étape 1 — Lecteur de base

- Recherche de titres YouTube Music
- Lecture en arrière-plan, écran verrouillé et centre de contrôle
- File d'attente réordonnable, complétée automatiquement par la radio du titre
- Cache des titres écoutés (1,5 Go max) et préchargement du titre suivant
- Lecteur plein écran avec la miniature du clip en 16:9 et bouton AirPlay
- Historique dans Accueil et Bibliothèque

## Compiler

Pas besoin de Mac : chaque push sur `main` lance GitHub Actions (`.github/workflows/build.yml`), qui :

1. génère le projet Xcode avec XcodeGen (`project.yml`) ;
2. compile l'app sans signature ;
3. publie `Nova.ipa` dans la release **latest** du dépôt.

## Installer sur l'iPhone

L'IPA n'est pas signée : il faut la signer avec ton identifiant Apple.

**Avec Sideloadly (Windows)**
1. Installe iTunes et iCloud depuis le site d'Apple (pas la version Microsoft Store), puis [Sideloadly](https://sideloadly.io).
2. Télécharge `Nova.ipa` depuis la release **latest**.
3. Branche l'iPhone, glisse l'IPA dans Sideloadly, saisis ton identifiant Apple et lance.
4. Sur l'iPhone : Réglages › Général › VPN et gestion de l'appareil › fais confiance à ton identifiant.
5. Active le mode développeur si iOS le demande (Réglages › Confidentialité et sécurité).

Avec un identifiant Apple gratuit, l'app expire au bout de 7 jours : relance Sideloadly, ou utilise SideStore pour la re-signer automatiquement depuis l'iPhone.

## Avertissement

Nova utilise l'API interne de YouTube Music, ce que les conditions d'utilisation de YouTube n'autorisent pas. Projet à usage strictement personnel.
