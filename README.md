# Voxcord Web 0.6.0

<img src="native-port/voxcord.svg" width="72" height="72" alt="Logo Voxcord">

Voxcord Web ouvre Discord dans une fenêtre Windows **Tauri / WebView2**. Le site Discord fournit la connexion, les messages, les serveurs, le vocal, les caméras et le partage d’écran. La fenêtre de Voxcord garde sa propre session entre les démarrages.

Lance **Voxcord-Web-Setup.exe** sur Windows 10 ou 11 x64, puis connecte-toi sur la page de Discord. WebView2 est installé par le setup si nécessaire. Fermer la fenêtre la range dans la zone de notification. Pour fermer complètement Voxcord, choisis **Quitter** dans le menu de son icône près de l’horloge.

## Extensions

Le mode standard ouvre Discord Web sans injecter les extensions Voxcord ou Vencord. Pour utiliser les fonctions supplémentaires, fais un clic droit sur l’icône Voxcord près de l’horloge et choisis **Activer les extensions non officielles et redémarrer**. Le même menu permet de revenir au mode standard. Fais ce changement en dehors d’un appel, car le redémarrage coupe la connexion vocale.

- **Soundboard et télécommande** ouvre la bibliothèque, l’import de fichiers audio, la recherche Myinstants et le contrôle depuis le téléphone. L’envoi de sons utilise le microphone d’un appel actif.
- **Paramètres Voxcord** (`Ctrl` + `Alt` + `V`) donne accès aux raccourcis Windows et aux outils caméra, audio et partage d’écran.
- **Vencord** charge ses thèmes et plugins en mode Extensions. Les réglages initiaux laissent FakeNitro et son contournement des limites de partage désactivés.

Voxcord Web est une application indépendante de Discord. Discord interdit les modifications du client dans ses [règles d’utilisation](https://discord.com/safety/platform-manipulation-policy-explainer). Le mode Extensions ajoute de telles modifications.

Voxcord Web a un profil Windows séparé de NovaCord et de [Voxcord natif Rust/Slint](native-port/README.md). Une première connexion est nécessaire dans le profil Web. Les détails des fonctions audio et de la télécommande sont décrits dans la [documentation de NovaCord](docs/novacord-legacy.md).

## Compilation et vérification

Le [workflow Windows](.github/workflows/build-windows.yml) prépare l’archive `Voxcord-Web-Windows-x64` avec l’installateur, le portable et les sources exactes de Vencord. Il vérifie la page de connexion de Discord en mode standard, le refus d’accès aux commandes des extensions depuis cette page, puis l’ouverture de la soundboard et l’import d’un WAV en mode Extensions. Les tests audio et caméra utilisent des sources simulées. Un vrai appel avec plusieurs caméras reste à essayer sur le matériel concerné.
