# Wakfu Combo Overlay

Application de bureau autonome (Electron) qui lit les logs de combat Wakfu en temps réel et affiche les sorts lancés par tes personnages sur un overlay OBS, sous forme d'icônes qui défilent.

Aucun rapport avec l'outil Stream Deck de ce dépôt (`index.js`, `heroes.json`, `profiles/*.json`) — ils ne partagent aucun état, aucun port, aucun fichier de config. Cette appli vit entièrement dans `electron/`.

---

## Ce que ça fait

1. Surveille `wakfu.log` (le fichier de logs du client Wakfu) et détecte chaque ligne `[Information (combat)] <Personnage> lance le sort <Sort>`.
2. Ne garde que les sorts lancés par les personnages que tu as explicitement ajoutés et cochés — tout le reste (autres joueurs, mobs) est ignoré automatiquement, puisque le log donne directement le nom du lanceur.
3. Diffuse ces sorts (avec leur icône) vers une page web locale, à ajouter comme **Source Navigateur** dans OBS.
4. Une fenêtre de réglages (accessible depuis l'icône dans le tray Windows) permet de gérer tout ça sans toucher à un fichier de config à la main.

---

## Prérequis

- Node.js 18+
- Windows (le chemin des logs Wakfu et le mécanisme de veille de fichiers sont spécifiques à Windows)
- Wakfu installé via le launcher Zaap

---

## Lancer en développement

```bash
npm install
npm run electron:dev
```

Une icône apparaît dans le tray Windows (souvent rangée dans la zone des icônes cachées, la flèche `^` à côté de l'horloge) et la fenêtre de réglages s'ouvre automatiquement au premier lancement.

## Générer un exécutable

```bash
npm run dist
```

Produit un installeur Windows (NSIS) dans `dist/`.

---

## Configuration dans OBS

1. Ajoute une source **Navigateur** dans ta scène.
2. URL : `http://localhost:3457`
3. La page a un fond transparent — elle se superpose directement à ta capture de jeu.
4. Place-la **au-dessus** de la capture de jeu dans la liste des sources (l'ordre de la liste détermine l'ordre d'affichage).

L'aperçu OBS affiche déjà la source en direct sans avoir besoin de démarrer le streaming ou l'enregistrement.

---

## Fenêtre de réglages

- **Héros suivis** : coche/décoche qui doit apparaître sur l'overlay. Un formulaire permet d'**ajouter** un personnage (nom affiché, nom exact du personnage en jeu, couleur) et un bouton **✕** permet d'en **retirer** un. Tout est sauvegardé immédiatement, pas de bouton "Enregistrer".
- **Disposition de la liste** : orientation (verticale/horizontale) et sens d'apparition des nouvelles entrées.
- **Diagnostic** : chemin du dossier de logs surveillé (et s'il est trouvé), nombre de clients connectés à l'overlay (OBS ou navigateur), et un journal d'activité en temps réel qui montre chaque sort détecté et ce qu'il en advient (envoyé / ignoré car non suivi / ignoré car joueur ou mob inconnu). Chaque héros a aussi un bouton **Tester** qui envoie un faux sort à l'overlay, pour vérifier l'affichage sans avoir à jouer.

Fermer la fenêtre (✕) la cache dans le tray mais **ne quitte pas l'appli** — le suivi continue en arrière-plan pendant le stream. Pour fermer complètement : clic droit sur l'icône du tray → **Quitter**, ou `Ctrl+C` dans le terminal si lancé en dev.

---

## Fichiers et dossiers

- `electron/main.js` — process principal (tray, fenêtre, câblage du lecteur de logs vers l'overlay)
- `electron/preload.js` — pont IPC exposé à la fenêtre de réglages
- `electron/settings/` — HTML/CSS/JS de la fenêtre de réglages
- `electron/overlay/` — HTML/CSS/JS de la page servie à OBS
- `../src/wakfuCombatLogReader.js` — lecture incrémentale de `wakfu.log`
- `../src/characterMatcher.js` — filtrage joueur suivi vs. random/mob (option `strict`)
- `../src/settingsStore.js` — persistance des réglages (héros suivis, disposition)
- `../overlay/server.js` — petit serveur HTTP/SSE générique, réutilisé par cette appli
- `../data/spellIcons.json` — table nom de sort → icône, générée par `../tools/scrape_spell_icons.js`

Les réglages sont sauvegardés dans `%APPDATA%\Wakfu Combo Overlay\settings.json` — indépendant du dossier du projet, ils survivent à une réinstallation.

---

## Régénérer les icônes de sorts

```bash
node tools/scrape_spell_icons.js
```

Récupère le nom officiel et l'icône de chaque sort pour les 18 classes depuis l'encyclopédie Wakfu, et les stocke dans `assets/icons/<classe>/<id>.png` + `data/spellIcons.json`. Volontairement lent (délai entre chaque requête) — un lancement à froid prend plusieurs dizaines de minutes, un relancement ne re-télécharge que ce qui manque.

L'overlay est actuellement **icône seule** : un sort sans icône connue dans cette table n'affiche rien du tout (pas de texte de secours). Relance le script ci-dessus si un personnage d'une classe pas encore couverte n'affiche rien.

---

## Dépannage

**Un sort est bien détecté (visible dans le journal de diagnostic) mais n'apparaît pas sur l'overlay**
→ Vérifie que le sort a une icône dans `data/spellIcons.json` (l'affichage est icône seule, pas de texte de secours). Sinon, relance `node tools/scrape_spell_icons.js`.

**Rien ne s'affiche du tout dans OBS**
→ Vérifie le compteur "Connectés" dans le panneau Diagnostic. À zéro, OBS n'est pas connecté à la page (mauvaise URL, ou source pas encore chargée).
→ Vérifie l'ordre des sources dans OBS (la Source Navigateur doit être au-dessus de la capture de jeu).
→ Une page qui n'a jamais rien affiché peut ne pas se "peindre" dans OBS tant qu'un premier changement ne survient pas — le bouton **Tester** sert justement à déclencher ce premier rendu.

**Le dossier de logs est marqué "introuvable"**
→ Wakfu n'a peut-être jamais été lancé sur cette machine, ou est installé ailleurs que via Zaap.

**"address already in use" au lancement**
→ Une instance tourne déjà (souvent invisible : fermer la fenêtre ne quitte pas l'appli). Cherche "Wakfu Combo Overlay" dans le Gestionnaire des tâches, ou utilise "Quitter" depuis le tray avant de relancer.
