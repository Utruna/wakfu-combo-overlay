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
