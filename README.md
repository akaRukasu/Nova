# Nova

Lecteur musical iOS personnel qui lit le catalogue YouTube Music, avec une interface Liquid Glass (iOS 26 et plus).

## Fonctionnalités

**Écouter**
- Recherche complète : titres, vidéos, albums, artistes, playlists, avec suggestions et recherches récentes
- Accueil YouTube Music (sélection rapide, mix, nouveautés, classements…)
- Pages artiste (titres populaires, albums, singles, artistes similaires), album et playlist
- Lecture en arrière-plan, écran verrouillé, centre de contrôle et AirPlay
- File d'attente réordonnable, complétée automatiquement par la radio du titre
- Lecture aléatoire, répétition (tout ou un titre), minuteur de veille
- Paroles du titre en cours
- Reprise de la file et de la position au lancement

**Bibliothèque**
- Titres likés, playlists perso (créer, renommer, réordonner), albums, playlists et artistes enregistrés
- Historique d'écoute
- Téléchargements hors ligne (titre, album ou playlist entière)
- Cache des titres écoutés (1,5 Go max) et préchargement du titre suivant

**Compte YouTube**
- Connexion avec ton compte Google (bouton profil en haut de l'Accueil ou de la Bibliothèque)
- Accueil personnalisé, et dans la Bibliothèque : titres likés, playlists, albums, artistes et historique du compte
- Les « J'aime » donnés dans Nova sont envoyés à ton compte

## Compiler

Pas besoin de Mac : chaque push lance GitHub Actions (`.github/workflows/build.yml`), qui :

1. génère le projet Xcode avec XcodeGen (`project.yml`) ;
2. compile l'app sans signature ;
3. publie `Nova.ipa` dans la release **latest** du dépôt (seulement depuis `main` ; sur les autres branches, l'IPA est dans les artefacts du build).

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
