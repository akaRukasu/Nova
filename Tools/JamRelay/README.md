# Relais Jam Nova sur Ultra.cc

Ce petit service Node.js permet à des amis sur des réseaux différents de découvrir et rejoindre un Jam dans Nova. Chaque appareil lit les morceaux avec sa propre source. Le relais conserve en mémoire les Jams ouverts, les pseudonymes, la file et la position de lecture. Il n’a besoin d’aucun identifiant Octave ou YouTube Music.

## Installer dans son espace Ultra.cc

1. Connecte-toi à ton service par SSH et vérifie que Node.js 22 ou plus récent est disponible. Si nécessaire, suis [le guide Node.js d’Ultra.cc](https://docs.ultra.cc/unofficial-language-installers/install-nodejs). Exécute `app-ports free` et relève un port libre attribué à ton service.
2. Copie `server.mjs` et le dossier `web/` dans `~/nova-jam/`. Crée les réglages avec les commandes suivantes en remplaçant `PORT_LIBRE` par le port choisi.

   ```sh
   cd ~/nova-jam
   umask 077
   printf 'NOVA_JAM_PORT=%s\nNOVA_JAM_KEY=%s\n' PORT_LIBRE "$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')" > jam.env
   nohup node --disable-wasm-trap-handler --env-file=jam.env server.mjs > jam.log 2>&1 < /dev/null &
   ```

3. Dans `~/.apps/nginx/proxy.d/nova-jam.conf`, ajoute la route ci-dessous en remplaçant `PORT_LIBRE`. Le service écoute sur la boucle locale. Le proxy Ultra.cc fournit le HTTPS. Cette route utilise sa propre clé de cercle.

   ```nginx
   location = /nova-jam {
       auth_basic off;
       proxy_pass http://127.0.0.1:PORT_LIBRE;
       proxy_http_version 1.1;
       proxy_set_header Authorization $http_authorization;
   }
   location ^~ /nova-jam/app/ {
       auth_basic off;
       proxy_pass http://127.0.0.1:PORT_LIBRE;
   }
   ```

4. Exécute `app-nginx restart` pour appliquer la route. Depuis ton navigateur, l’adresse HTTPS `/nova-jam` doit répondre « Méthode indisponible ». Depuis Nova, enregistre le lien de la forme `https://utilisateur.serveur.usbx.me/nova-jam#CLE_DU_CERCLE`, où la clé est la valeur `NOVA_JAM_KEY` de `jam.env`.

Le relais intégré à Nova permet de créer une session directement dans **Jam → À distance**. Chaque session est accessible par son invitation. L’invité peut ouvrir Nova ou rejoindre avec son navigateur pour chercher un titre sur Octave et l’ajouter au lecteur de l’hôte. L’invitation expire quand l’hôte termine le Jam ou se déconnecte.

Pour activer la création sans configuration sur un relais dédié, ajoute `NOVA_JAM_PUBLIC_HOSTING=1` à son environnement et configure `proxy_set_header X-Nova-Client $remote_addr;` dans les routes API Nginx. Le relais doit rester accessible uniquement via le proxy et sa boucle locale. La clé hôte de la session est fournie lors de la création. Les cercles privés existants gardent leur propre clé et leur liste de sessions.

[Guide Ultra.cc pour les applications personnalisées](https://docs.ultra.cc/unofficial-application-installers/generic-software-installation) · [Ports attribués](https://docs.ultra.cc/unofficial-ssh-utilities/assigned-ports-command)
