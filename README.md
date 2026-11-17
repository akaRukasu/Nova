# Voxcord

<img src="native-port/voxcord.svg" width="72" height="72" alt="Logo Voxcord">

<img src="native-port/voxcord.svg" width="80" height="80" alt="Logo Voxcord">

Client Discord natif pour Windows, écrit en **Rust**, avec une interface **Slint**. L’interface de cette branche ne charge pas le site web de Discord et n’utilise ni Electron ni WebView2.

Le moteur provient de [Yapfast](https://github.com/yapfast/yapfast), sous GPL-3.0-or-later. Le portage, son identité visuelle et les corrections médias sont conservés dans [native-port](native-port/README.md). Chaque compilation fournit les sources exactes et les notices des dépendances.

## Installer

Ouvre le dernier lancement réussi de [Voxcord Native](https://github.com/akaRukasu/Nova/actions/workflows/native-port.yml), télécharge l’artefact **Voxcord-Windows-Setup**, puis extrais et lance **Voxcord-Setup.exe**. La version portable et les sources sont dans **Voxcord-portable-and-source**.

Le client natif précédent peut être mis à jour avec ce setup. Son dossier de données et son espace d’identifiants restent les mêmes pour conserver la connexion. Une première connexion affiche un QR code Discord.

## Version 0.5.0

- Interface native : serveurs, messages, messages privés, appels, caméras, partage d’écran et soundboard Discord avec recherche.
- Réception des caméras : conservation de l’état d’un flux lorsque d’autres participants arrivent, et récupération ciblée d’une image clé après un blocage.
- Barre des tâches : clignotement désactivé par défaut, y compris pour les anciens profils ; réactivation possible dans les réglages.
- Partage d’écran : FPS envoyés mesurés séparément de la cible, résolution réellement encodée et débits visibles dans les détails de connexion ; suppression du rattrapage en rafale après un retard.
- Nouveau nom, nouveau logo vectoriel et nouvel installeur Windows.

La chaîne vérifie les tests médias sur Windows, l’installation, les métadonnées et l’ouverture d’une fenêtre native. La réception de plusieurs caméras dans un véritable appel Discord reste à confirmer sur les machines concernées.

## État du portage

La bibliothèque de sons personnels, son injection dans le microphone, Myinstants la télécommande téléphone et les raccourcis d’action personnalisables de NovaCord 0.4.5 restent à porter. Cette version n’offre donc pas encore toutes les fonctions de NovaCord 0.4.5.

Le code historique Tauri reste présent pour ce travail de portage. Sa [documentation](docs/novacord-legacy.md) décrit uniquement l’ancien client WebView2 et ses fonctionnalités ; elle ne décrit pas Voxcord natif.
