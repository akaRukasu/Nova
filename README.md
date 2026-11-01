# NovaCord

Client Discord léger pour Windows, avec des plugins intégrés façon Vencord.

Au lieu d'embarquer son propre Chromium comme le client officiel (Electron), NovaCord affiche Discord dans **WebView2**, le moteur d'Edge déjà installé sur Windows 10 et 11. Le programme fait quelques Mo, et le vocal, la vidéo, le partage d'écran et la soundboard fonctionnent comme sur Discord.

## Ce qui allège Discord

- **Pas de Chromium embarqué** : le moteur WebView2 est partagé avec Windows et mis à jour par lui.
- **Mémoire réduite en arrière-plan** : quand la fenêtre est réduite ou rangée dans la zone de notification, NovaCord demande à WebView2 de libérer un maximum de mémoire. Le vocal et les notifications continuent de fonctionner.
- **Services d'Edge coupés** : traduction, shopping, collections, saisie automatique, enregistrement des mots de passe, SmartScreen, mises à jour de composants, requêtes de fond.
- **Mode éco** (plugin) : animations, transitions et flous désactivés.
- **Anti-pistage** (plugin) : la télémétrie de Discord n'est plus envoyée.

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

Les plugins agissent sur le réseau et sur le CSS, sans modifier le code interne de Discord (contrairement à Vencord). Les mises à jour de Discord les cassent donc rarement. Seul *Masquer les pubs Nitro* dépend de l'interface et peut demander un ajustement de temps en temps.

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

Prérequis sur Windows : [Rust](https://rustup.rs) et Node.js.

```sh
npx @tauri-apps/cli@2 dev     # lance en mode développement
npx @tauri-apps/cli@2 build   # produit l'installateur dans src-tauri/target/release/bundle/nsis
```

- `src-tauri/src/main.rs` : fenêtre, zone de notification, réglages WebView2, gestion de la mémoire.
- `mod/novacord.js` : plugins, thèmes et panneau de réglages, injectés dans Discord avant ses propres scripts.

## Ce que NovaCord ne fait pas

NovaCord ne simule pas Nitro : les fonctions payantes (stream au-delà de 720p 30 i/s, sons de soundboard d'autres serveurs, emojis animés partout…) restent réservées aux abonnés. La soundboard du serveur où tu es et les sons par défaut sont gratuits et fonctionnent normalement.

## Avertissement

Les clients modifiés ne sont pas autorisés par les conditions d'utilisation de Discord. Le risque de bannissement est faible mais réel, et il porte sur ton compte. Projet à usage personnel.
