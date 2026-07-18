# SpriteForge prototype

## Lancer

### En local (sans persistance)

```bash
npm install
npm start
```

### Avec la stack complète (MinIO + MongoDB)

```bash
docker compose up --build
```

Démarre l’app + MinIO (archivage des frames et sprite sheets) + MongoDB (historique de toutes les
générations, consultable via `GET /api/generations`). Les données survivent aux redémarrages grâce
aux volumes nommés. Variables : voir `.env.example` (changer le mot de passe MinIO en production).
Sur Dokploy : service « Compose », variables dans l’onglet Environment, domaine via l’onglet Domains
(service `app`, port 3000).

Puis ouvre `http://localhost:3000` (port configurable via la variable d’environnement `PORT`,
ou `APP_PORT` pour le mapping Docker Compose).

Le flux se fait en deux étapes pour garantir la cohérence inter-frames :

1. **Gabarit** : une image canonique est générée d’abord (pose neutre, personnage centré, fond
   transparent, `input_fidelity: "high"`) et affichée pour validation. C’est elle qui sert de
   référence à toutes les frames — pas la photo brute.
2. **Frames** : 24, 45 ou 100 images via l’API OpenAI Images Edit — par lots de 5 requêtes en
   parallèle, avec retry automatique — chacune passée dans un post-traitement déterministe
   (sharp) : recadrage sur l’ancre de la tête, normalisation colorimétrique vers le gabarit,
   aplatissement sur la couleur de fond choisie dans l’UI (identique au pixel près sur toutes
   les frames). Les modèles avec transparence native (gpt-image-1/1.5) sont générés sur fond
   transparent ; pour ceux qui ne l’ont pas (gpt-image-2), la teinte exacte du fond est imposée
   dans le prompt puis détourée au chroma côté serveur — même résultat final.

Le ZIP final contient :
- `frames/*.png`
- `sprite-sheet.png`
- `manifest.json` (paramètres, coût estimé, usage API, résumé du post-traitement)

La progression s’affiche en direct dans la page (barre + estimation du temps restant) ; le détail frame par frame est loggé dans la console du navigateur et dans le terminal du serveur. Si la génération échoue en cours de route, les frames déjà générées restent téléchargeables dans un ZIP partiel.

Une fois la génération terminée, la sprite sheet est jouée directement dans la page (canvas) avec
sliders de vitesse (1–30 img/s) et de zoom, et bouton lecture/pause. Chaque génération (réussie ou
non) est archivée dans MinIO (frames, sprite sheet, gabarit, ZIP, mini-preview) et enregistrée dans
MongoDB (paramètres, durée, coût estimé, usage API) quand la stack Docker Compose est utilisée.

La page **Bibliothèque** (`/library.html`, accessible depuis le header) liste toutes les générations
archivées : stats agrégées, animation jouée au survol de chaque carte, lecteur plein format
(vitesse/zoom/pause) et retéléchargement des ZIP — y compris les ZIP partiels des générations
échouées. Nécessite la stack Docker Compose (MongoDB + MinIO).

La clé API est utilisée en mémoire pour la requête et n’est pas persistée.

## Prix
L’interface utilise les tarifs officiels de sortie image OpenAI pour les tailles standard. Une édition avec image de référence entraîne aussi des coûts variables de tokens d’entrée image + texte. Le manifeste conserve les données `usage` renvoyées par l’API lorsqu’elles sont disponibles.
