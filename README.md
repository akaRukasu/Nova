# Nova

Lecteur musical iOS personnel qui lit le catalogue YouTube Music, avec une interface Liquid Glass (iOS 26 et plus).

## Fonctionnalités

**Interface inspirée d'Apple Music** : onglets Accueil, Nouveautés, Bibliothèque et Recherche, tuiles de catégories à parcourir, Bibliothèque par Playlists / Artistes / Albums / Titres likés avec « Ajouts récents », paroles et volume dans le lecteur, mini-lecteur au-dessus des onglets.

**Découvrir, Sorties, Concerts**
- Découvrir : mix découverte, titres, artistes et playlists similaires à partir de tes écoutes
- Sorties : toutes les nouveautés des genres que tu choisis, des artistes que tu suis et de ceux que tu écoutes le plus (7, 30 ou 90 jours), avec un point rouge sur les nouvelles depuis ta dernière visite
- Concerts : par artiste, pour tous tes artistes, autour de toi ou d'une ville, avec lien vers la billetterie. Nécessite une clé gratuite Ticketmaster (developer.ticketmaster.com) à coller dans Réglages › Concerts

**Bibliothèque comme Apple Music** : Playlists, Artistes, Albums, Morceaux (tous tes titres, sans doublons, triables), Titres likés, Téléchargés, et **playlists intelligentes** à règles (titre, artiste, album, durée, nombre d'écoutes, dernière écoute, date d'ajout, j'aime, téléchargé ; tous ou au moins un critère ; limite et tri), mises à jour automatiquement.

**Réglages** : qualité audio, lecture automatique, historique, données mobiles (cache, téléchargements), taille du cache, pays et langue du contenu, genres des sorties, clé Ticketmaster.

**AirPlay** : le bouton AirPlay du lecteur envoie le son vers une enceinte, une Apple TV ou un HomePod (c'est l'iPhone qui lit le titre).

**Rapidité** : les pages déjà vues (accueil, albums, playlists, artistes, paroles) s'affichent instantanément depuis le cache puis se mettent à jour ; les pochettes sont gardées sur disque (300 Mo) ; un titre déjà résolu se relance sans nouvelle extraction.

**CarPlay**
- L'écran « En cours » de CarPlay et les commandes au volant fonctionnent avec Nova sans réglage.
- L'interface CarPlay complète (Accueil, Bibliothèque, Récents) est prête dans l'app, mais CarPlay n'affiche une app que si sa signature contient l'autorisation `com.apple.developer.carplay-audio`, qu'Apple accorde sur demande à un compte développeur payant. Avec un identifiant Apple gratuit (Sideloadly), cette autorisation est retirée à la signature. Le fichier `Nova/Nova.entitlements` la contient pour le jour où tu signes avec un compte qui l'a obtenue.

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

**Importer depuis les autres plateformes** (Bibliothèque › Importer)
- Spotify et Deezer : connexion au compte, puis choix des playlists et des titres likés
- Apple Music : playlists de la bibliothèque de l'iPhone
- Lien public de playlist ou d'album : Spotify, Deezer, Apple Music, YouTube / YouTube Music
- Fichier CSV, TXT ou JSON : TuneMyMusic et Soundiiz (pour Tidal, Amazon Music, SoundCloud, Qobuz…), Exportify, export de données Spotify
- Chaque titre est retrouvé sur YouTube Music ; les titres introuvables sont listés

**Compte YouTube**
- Connexion avec ton compte Google (bouton profil en haut de l'Accueil ou de la Bibliothèque)
- Accueil personnalisé, et dans la Bibliothèque : titres likés, playlists, albums, artistes et historique du compte
- Les « J'aime » donnés dans Nova sont envoyés à ton compte

## Compiler

Pas besoin de Mac : chaque push lance GitHub Actions (`.github/workflows/build.yml`), qui :

1. génère le projet Xcode avec XcodeGen (`project.yml`) ;
2. compile l'app sans signature ;
3. publie `Nova.ipa` dans la release **latest** du dépôt (seulement depuis `main` ; sur les autres branches, l'IPA est dans les artefacts du build).

Le workflow `diagnostic.yml` compile le client YouTube Music pour macOS et l'exécute contre les vrais serveurs (recherche, accueil, pages, paroles, import) : son journal montre ce que Nova comprend des réponses.

> Dépôt privé : chaque build macOS consomme dix fois plus de minutes GitHub Actions. Si les builds échouent en quelques secondes sans démarrer, le quota mensuel est épuisé (Réglages GitHub › Billing).

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
