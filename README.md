# NovaCord

Client Discord léger pour Windows, avec Vencord embarqué, raccourcis Windows personnalisables et soundboard dans le microphone.

Au lieu d'embarquer son propre Chromium comme le client officiel (Electron), NovaCord affiche Discord dans **WebView2**, le moteur d'Edge déjà installé sur Windows 10 et 11. Le programme fait quelques Mo, et utilise le client web de Discord pour le vocal, la vidéo et le partage d'écran.

## Ce qui allège Discord

- **Pas de Chromium embarqué** : le moteur WebView2 est partagé avec Windows et mis à jour par lui.
- **Mémoire réduite en arrière-plan** : quand la fenêtre est réduite ou rangée dans la zone de notification, NovaCord demande à WebView2 de libérer un maximum de mémoire. Le vocal et les notifications continuent de fonctionner.
- **Services d'Edge coupés** : traduction, shopping, collections, saisie automatique, enregistrement des mots de passe, SmartScreen, mises à jour de composants, requêtes de fond.
- **Mode éco** (plugin) : animations, transitions et flous désactivés.
- **Anti-pistage** (plugin) : la télémétrie de Discord n'est plus envoyée.

## Streams, raccourcis et soundboard (0.2.1)

Ouvre **Paramètres NovaCord** depuis l'icône près de l'horloge (ou `Ctrl + Alt + N` tant que tu n'as pas changé ce raccourci).

- **Qualité des streams** : Vencord est maintenant réellement embarqué, avec `FakeNitro`, `WebScreenShare`, `WebScreenShareFixes` et `WebKeybinds` activés par défaut. Au lancement d'un partage, le sélecteur Vencord propose la résolution et les images/seconde (1080p / 60 par défaut). Cela configure ton émission : les performances dépendent de la source, du matériel et du réseau. Cela n'améliore pas la qualité du stream émis par quelqu'un d'autre.
- **Créer tes raccourcis** : section *Raccourcis personnalisés* → *Ajouter un raccourci* → choisir une action → *Enregistrer les touches* → saisir ta combinaison → *Enregistrer les raccourcis*. Ils sont enregistrés dans Windows et restent actifs en arrière-plan. Les conflits et doublons sont signalés ; si l'enregistrement échoue, les anciens raccourcis sont restaurés. Actions : micro, casque, mode streamer, mode vocal, paramètres, jouer un son, arrêter les sons. Le changement de mode vocal ne crée pas un raccourci « maintenir pour parler ».
- **Soundboard** : active *Soundboard dans le micro*. Le mixeur se branche sur les pistes WebRTC sortantes, même si le vocal est déjà connecté. Ouvre la soundboard de Discord une fois pour charger les sons auxquels ton compte a accès, puis clique sur *Actualiser les sons Discord* dans NovaCord. Tu peux aussi importer tes fichiers audio (8 Mo maximum) : ils restent stockés localement. Rouvre le panneau après un import pour pouvoir attribuer un raccourci au son.

Les sons sont mélangés à ta piste micro : les autres peuvent les entendre sans utiliser l'API soundboard native. Ils n'ont pas ses animations ni son réglage de volume séparé chez les auditeurs. Le micro doit être ouvert ; en appuyer-pour-parler, il faut aussi maintenir ta touche de parole. La suppression du bruit peut atténuer les sons. Désactiver la soundboard arrête ses sons et laisse la voix fonctionner ; reconnecter le vocal retire aussi le mixeur.

### Correction des médias en 0.2.1

- La caméra et le flux original de capture ne sont plus modifiés par le mixeur. Un format caméra trop strict peut être relâché automatiquement en conservant le périphérique choisi. Le panneau propose un aperçu local, libéré dès l'arrêt du test ou la fermeture du panneau, avec les erreurs de permission/périphérique.
- La soundboard remplace uniquement la piste audio du transmetteur WebRTC. L'activation fonctionne après la connexion au vocal, et la désactivation restaure la piste d'origine. Le micro reste soumis à sa coupure et au mode de transmission. Les changements de microphone et la fermeture de la connexion libèrent le mixeur sans arrêter le périphérique appartenant à Discord.
- « Jouer dans le vocal » transmet le son ; « Écouter chez moi » est un aperçu local. Quand le mixeur est activé, les requêtes d'envoi de la soundboard native sont redirigées vers cette même sortie vocale. Les boutons que Discord bloque avant l'envoi restent soumis à son interface : utilise alors la liste du panneau NovaCord.
- Le profil de partage utilise la résolution et la fréquence choisies, au lieu des valeurs maximales fixes de 4K/120 i/s. La couche vidéo haute conserve ce profil et un budget de débit adapté. Le panneau affiche séparément la cible, la capture et les dimensions/fréquence/débit réellement encodés, ainsi que les limitations indiquées par WebRTC. La qualité réelle dépend toujours de la source, du processeur et du réseau.

Les tests Edge créent deux pairs WebRTC et mesurent le niveau sonore reçu, avec la caméra active ; ils vérifient aussi un envoi vidéo 1280 × 720. Ils utilisent des périphériques simulés et une page contrôlée. Ils ne remplacent pas un essai avec le matériel de l'utilisateur dans un appel Discord réel.

## Plugins

Ouvre le panneau avec **Ctrl + Alt + N**, ou clic droit sur l'icône de la zone de notification › *Paramètres NovaCord*. Les changements s'appliquent tout de suite.

| Plugin | Par défaut | Effet |
|---|---|---|
| Anti-pistage | activé | Bloque `science`, `metrics` et Sentry |
| Mode éco | activé | Coupe animations, transitions et flous |
| Masquer les pubs Nitro | activé | Cache le bouton cadeau, l'onglet Nitro, la boutique et les quêtes |
| Liens propres | activé | Retire `utm_`, `fbclid`, `si`… des liens envoyés |
| Frappe invisible | désactivé | N'envoie plus l'indicateur « est en train d'écrire » |
| Réponses sans mention | désactivé | Répondre ne mentionne plus l'auteur |
| Interface compacte | désactivé | Réduit les marges |

Également : thèmes (AMOLED, Minuit, Nord) et **CSS personnalisé** appliqué en direct.

Les plugins NovaCord ci-dessus agissent sur le réseau et le CSS. Vencord ajoute les patches internes nécessaires aux fonctions avancées. Une mise à jour de Discord peut nécessiter de mettre à jour la version Vencord embarquée ; le panneau permet de vérifier son chargement et d'ouvrir ses réglages.

## Autres comportements

- Fermer la fenêtre la range dans la zone de notification ; *Quitter* se trouve dans le menu de l'icône.
- Une seule instance : relancer NovaCord remet la fenêtre au premier plan.
- Les liens externes s'ouvrent dans ton navigateur par défaut.
- L'icône de la barre des tâches clignote quand tu reçois une mention et que la fenêtre n'est pas au premier plan.
- `NovaCord.exe --minimized` démarre directement dans la zone de notification (pratique pour le lancement au démarrage de Windows).

## Installer

Chaque push sur la branche `novacord` lance GitHub Actions (`.github/workflows/build-windows.yml`), qui compile sur Windows et publie dans la release **novacord-latest** :

- `NovaCord-Setup.exe` : installateur (sans droits administrateur) ;
- `NovaCord-portable.exe` : version portable, à lancer directement.

Windows SmartScreen affichera « Windows a protégé votre ordinateur », car l'exécutable n'est pas signé : *Informations complémentaires* › *Exécuter quand même*.

## Développer

Prérequis sur Windows : [Rust](https://rustup.rs), Node.js 24 et pnpm.
Prépare d'abord la version Vencord épinglée :

```sh
git clone https://github.com/Vendicated/Vencord .vencord
git -C .vencord checkout 8d64c8be7e68616f8f116a6fff9480051aa2a0c5
pnpm --dir .vencord install --frozen-lockfile
node scripts/prepare-vencord.mjs .vencord
node --test tests/*.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml
```

```sh
npx @tauri-apps/cli@2 dev     # lance en mode développement
npx @tauri-apps/cli@2 build   # produit l'installateur dans src-tauri/target/release/bundle/nsis
```

- `src-tauri/src/main.rs` : fenêtre, zone de notification, réglages WebView2, gestion de la mémoire.
- `mod/novacord.js` : plugins, thèmes et panneau de réglages, injectés dans Discord avant ses propres scripts.

## Code Vencord embarqué

Vencord est compilé à partir du commit `8d64c8be7e68616f8f116a6fff9480051aa2a0c5` de [Vendicated/Vencord](https://github.com/Vendicated/Vencord), sous GPL-3.0-or-later. Aucun script distant n'est téléchargé à l'exécution. La release inclut sa licence et une archive du code source utilisé, avec l'adaptateur NovaCord.

La compilation des branches `codex/novacord-*` produit un artefact de test et ne remplace pas la release `novacord-latest`.

## Avertissement

Les clients modifiés ne sont pas autorisés par les conditions d'utilisation de Discord. Le risque de bannissement est faible mais réel, et il porte sur ton compte. Projet à usage personnel.
