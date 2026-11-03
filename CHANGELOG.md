## v2.3.0

### Nouveau : récap des combats

Une nouvelle fenêtre revient sur chaque combat de la session : qui a fait quoi, et comment.

- Ouvre-la avec le bouton **Récap des combats** des réglages, depuis le menu de l'icône de l'appli, ou avec le bouton **Récap** de l'affichage tête haute. Un badge « nouveau » signale un combat que tu n'as pas encore regardé.
- Pour chaque combat : les adversaires, la durée, le nombre de tours, la victoire, et le classement de tes héros en **Dégâts**, **Soins**, **Armure** ou **Dégâts subis**.
- Clique sur un héros pour voir son **meilleur tour** avec les sorts lancés : survole un sort pour voir ce qu'il a fait, coup par coup et cible par cible. Tu as aussi le total de chaque sort sur le combat (les sorts sans dégâts, comme les buffs et invocations, sont listés en grisé à la fin), la répartition par élément, et ses soins, son armure et ses dégâts subis.
- Dans l'onglet **Soins**, tout passe aux soins : meilleur tour de soins, soins par sort et personnes soignées. Les soins qui ne viennent pas d'un sort (vol de vie, marques, passifs) sont comptés à part, sous leur nom. L'onglet **Armure** fait de même pour l'armure donnée : elle compte pour celui qui la donne (une Faille qui protège deux alliés compte pour son lanceur), avec les alliés protégés.
- Le récap se remplit en direct pendant le combat. L'interrupteur **Autres joueurs du groupe** affiche aussi les joueurs que tu ne suis pas.

Pour t'y retrouver dans tes combats :

- **Chercher un monstre**, au-dessus de la liste, propose les monstres rencontrés dans une liste déroulante et ne garde que les combats où ce monstre était présent (majuscules et accents ignorés).
- **Sauvegarder**, à droite des onglets, garde le combat affiché même après la fermeture de l'appli. Les combats sauvegardés des sessions précédentes s'affichent sous **Sauvegardés**, avec leur date.
- Survole un combat terminé pour faire apparaître sa **corbeille**. Un second clic sur « Supprimer ? » le retire du récap (et du disque s'il était sauvegardé).

Le jeu n'indique pas quel sort a fait quels dégâts : l'appli attribue chaque coup au sort lancé juste avant, ou au sort que le jeu nomme quand il le fait. Les soins et l'armure comptent pour celui qui les donne. Un soin sur un allié déjà plein de vie (« +0 PV » dans le jeu) ne compte pas. Les combats sont gardés jusqu'à ce que tu quittes l'appli, sauf ceux que tu sauvegardes.

### Nouveau : compteurs de soins et d'armure

À côté du compteur de dégâts, deux petits compteurs montrent les **soins** (rose) et l'**armure** (vert) que le héros a donnés, dans OBS comme dans l'affichage tête haute. Ils suivent le réglage **Tour / Combat** et restent masqués tant qu'ils valent 0.

Soins et armure comptent pour celui qui les donne : le héros qui joue, le propriétaire d'une marque ou d'un passif (« Marque Husse », « Radiance »…), et le vol de vie pour celui qui se soigne. **Pense à ajuster ta source OBS** : en horizontal, elle gagne environ 90 px de large (854 × 130 au lieu de 766 × 130 pour 8 sorts à 48 px). En vertical, elle perd au contraire environ 90 px de haut (188 × 554 au lieu de 188 × 643), car l'icône de classe ne descend plus le long de la liste (voir plus bas). La taille exacte s'affiche dans la page Affichage et dans l'assistant.

### Overlay : l'icône de classe ne bouge plus

Dans les 4 sens de défilement, l'overlay reste accroché à un coin fixe et l'icône de classe ne bouge plus : le dernier sort arrive toujours juste à côté d'elle et la liste défile dans l'autre sens. En vertical **haut → bas**, le dernier sort est en haut et les plus anciens descendent ; en **bas → haut**, tout l'overlay est accroché en bas, le dernier sort aussi, avec le compteur, les soins et l'armure empilés au-dessus de l'icône. Le « +N » de chaque coup descend sous le compteur en horizontal, et monte à côté de lui en vertical.

### Affichage tête haute : nouvelle barre de contrôle

- Au-dessus de l'overlay (en dessous en vertical bas → haut), une petite barre réunit tout ce qui se clique (verticale quand l'overlay est vertical) : une **poignée** pour déplacer la fenêtre en la faisant glisser, **Tour / Combat** pour le compteur, et **Récap**. Le reste de la fenêtre laisse toujours passer les clics vers Wakfu.
- La fenêtre prend toute seule la bonne taille selon tes réglages d'affichage, avec de la marge, pour que rien ne soit jamais coupé. Le mode « Déplacer / redimensionner » des réglages disparaît.

### Assistant : mode streamer ou mode joueur

- L'assistant de premier lancement te demande maintenant comment tu utilises l'appli. En **mode streamer**, il t'aide à ajouter l'overlay dans OBS, comme avant. En **mode joueur**, il active l'affichage tête haute et te montre comment t'en servir.
- Ce tuto de l'affichage tête haute reste disponible avec le bouton **Tuto**, à côté de son interrupteur dans la page Affichage.

### Corrections et sécurité

- Quand Wakfu recrée son fichier de log, l'appli s'en rend compte même si le nouveau fichier est déjà plus long que l'ancien : avant, elle pouvait rater des sorts.
- Le serveur local de l'overlay ne répond plus qu'à OBS et à l'appli : une page web ouverte dans ton navigateur ne peut plus lire tes sorts ni actionner les boutons de l'affichage tête haute.
- Une position enregistrée invalide pour l'affichage tête haute est ignorée au lieu de donner une fenêtre de taille aberrante.
- Mise à jour de composants de l'appli qui corrige des failles de sécurité connues.

### Nouveau : fenêtre des nouveautés

Après chaque mise à jour, une petite fenêtre présente ce qui a changé, à l'ouverture des réglages. Tu peux la rouvrir quand tu veux avec **Nouveautés et historique** en bas des réglages (ou en cliquant sur le numéro de version), ou depuis **Nouveautés** dans le menu de l'icône de l'appli. **Voir tout l'historique des versions** affiche le changelog complet.

Dans OBS, pense à actualiser la source navigateur après la mise à jour.

## v2.2.0

### Nouveau : compteur de dégâts du tour ou du combat

Le compteur de dégâts peut maintenant afficher, au choix, les dégâts **du tour** (comme avant) ou le cumul **du combat** pour chaque héros.

- Choisis le mode dans la page Affichage, sous **Compteur de dégâts** (« Du tour » / « Du combat »). L'étiquette du compteur indique « Tour » ou « Combat ».
- En mode combat, chaque héros garde son propre total, invocations comprises, et repart de zéro au combat suivant.
- Dans l'**affichage tête haute**, un petit interrupteur sous le compteur permet de basculer d'un clic sans quitter le jeu. C'est le seul endroit de la fenêtre qui capte la souris : le reste laisse toujours passer les clics vers Wakfu. Le choix est retenu et s'applique aussi à OBS.

### Corrections

- Les icônes ne clignotent plus quand on change un réglage d'affichage qui ne touche pas à la liste des sorts.

Dans OBS, pense à actualiser la source navigateur après la mise à jour.

## v2.1.1

### Corrections de l'icône de classe

- **Plus de clignotement** : l'icône de classe était redessinée à chaque sort lancé et à chaque sort qui disparaissait, ce qui la faisait sauter. Elle reste maintenant parfaitement stable tant que le même héros joue.
- **Animation d'apparition au bon moment** : elle ne se joue plus qu'au premier sort de chaque tour (y compris quand le même héros enchaîne un nouveau tour), et plus à chaque sort.
- **Disparition en douceur** : quand tous les sorts ont disparu, l'icône de classe et le compteur de dégâts s'effacent en même temps que le dernier sort, au lieu de disparaître d'un coup.
- **Icônes plus réactives** : depuis la 2.0, les icônes étaient retéléchargées à chaque affichage, ce qui pouvait les faire apparaître en retard. Elles sont de nouveau gardées en mémoire.

Ces corrections s'appliquent à OBS comme à l'affichage tête haute. Dans OBS, pense à actualiser la source navigateur après la mise à jour.

## v2.1.0

### Nouveau : affichage tête haute

L'overlay peut maintenant s'afficher directement par-dessus Wakfu, sans OBS : pratique si tu ne streames pas.

- Active **Affichage tête haute** dans la page Affichage, ou d'un clic droit sur l'icône de l'appli dans la zone de notification.
- La fenêtre est transparente et laisse passer les clics : tu joues normalement.
- Par défaut, elle ne s'affiche que quand une fenêtre Wakfu est au premier plan, et se cache dès que tu passes sur autre chose (désactivable).
- **Déplacer / redimensionner** pour la placer où tu veux, puis **Verrouiller la position** : elle s'en souvient au prochain lancement.

Wakfu doit être en fenêtré ou en plein écran fenêtré : en plein écran exclusif, aucune fenêtre ne peut s'afficher par-dessus le jeu.
