# Cohérence inter-frames (fond, teintes, cadrage) — conception

Date : 2026-07-18 · Statut : validé par l'utilisateur (option « Pipeline complet »)

## Problème

Chaque frame est un `images.edit` indépendant ancré sur la photo brute : le modèle ré-invente à
chaque appel la teinte du fond, l'étalonnage (peau, t-shirt) et le cadrage. Résultat : sauts de
fond, dérives de couleur et de position à l'animation. Pas de seed côté API → la cohérence ne peut
pas venir du prompt seul.

## Décision

Pipeline « gabarit + post-traitement déterministe » :

1. **Gabarit (master frame)** — une image canonique est générée d'abord (pose neutre, centrée,
   fond transparent, `input_fidelity: "high"`), affichée dans l'UI pour validation, puis utilisée
   comme unique référence de toutes les frames. Endpoint `POST /api/template`, stockage en mémoire
   (TTL 60 min), image servie par `GET /api/template/:id/image`.
2. **Fond transparent + composition serveur** — chaque frame est demandée avec
   `background: "transparent"` ; sharp aplatit sur une couleur unie choisie dans l'UI
   (input color, défaut `#6b7a96`). Fond identique au pixel près par construction.
3. **Recadrage déterministe** — le masque alpha donne la silhouette ; l'ancre est le centroïde de
   la bande haute (~22 % de la hauteur du personnage : la tête, stable face aux gestes). Chaque
   frame est recalée sur l'ancre du gabarit, décalage plafonné à ±8 % de la largeur.
4. **Normalisation colorimétrique** — alignement moyenne/écart-type par canal RGB, calculé sur les
   pixels du personnage uniquement (masque alpha), vers les stats du gabarit. Gains bornés
   [0.75, 1.3].

Écarté : chaînage séquentiel (dérive cumulative, perte du parallélisme ×5), génération vidéo Sora
(perte du contrôle frame par frame), QC auto avec régénération (option non retenue par
l'utilisateur).

## Composants

- `postprocess.mjs` (nouveau) : `analyze(buffer)` → stats alpha/couleur/ancre ;
  `conform(buffer, refStats, background)` → frame corrigée (couleur → position → aplatissement).
  Analyse sur une version réduite (256 px) pour la vitesse.
- `server.mjs` : endpoint gabarit ; `runJob` passe `background`/`input_fidelity` (sauf
  `gpt-image-1-mini`, non supporté) et applique `conform()` à chaque frame ; le gabarit est archivé
  dans MinIO (`template.png`) et référencé dans le document MongoDB (+ résumé du post-traitement).
- Front : bouton principal en deux temps (« Générer le gabarit » → « Générer N frames »), panneau
  d'aperçu du gabarit sur la couleur de fond choisie, invalidation du gabarit au changement d'image
  source.

## Modèles sans transparence (gpt-image-2)

`gpt-image-2` ne supporte ni `input_fidelity` ni la génération avec transparence (confirmé en
production). Pour les modèles du set `opaqueModels` (pré-rempli avec gpt-image-2, complété
dynamiquement quand une image revient opaque) :

- le prompt impose la teinte exacte du fond (`solidBgLine(bg)` : hex + RGB, « perfectly flat,
  uniform, solid matte background ») au lieu de demander la transparence ;
- `keyBackground()` détoure ensuite le fond côté serveur : couleur échantillonnée sur un anneau de
  bordure de 3 px, remplissage depuis les bords (tolérance 90 en somme d'écarts RGB — seules les
  zones connectées au bord sont effacées, un vêtement de couleur proche au centre n'est pas mangé),
  masque adouci par un léger flou, alpha fusionné manuellement en RGBA ;
- le reste du pipeline (analyse, recadrage, normalisation, aplatissement) est inchangé : le
  détourage ne fait que synthétiser l'alpha que le modèle n'a pas fourni.

Pièges sharp découverts par les tests : une image opaque passée dans `ensureAlpha()` a une
couverture alpha de 100 % — `analyze()` considère « inutilisable » toute couverture > 0,95 ; et le
raw d'un masque 1 canal peut ressortir multi-canaux après `blur()` — toujours lire `info.channels`.

## Dégradation gracieuse

Si une frame revient sans alpha exploitable même après détourage, le post-traitement
géométrique/couleur est sauté pour cette frame (log warn) et l'image est utilisée telle quelle.
L'ancien flux sans `templateId` reste fonctionnel (compatibilité API).

## Validation

Mock OpenAI renvoyant des frames volontairement dégradées (offsets ±40 px, teintes ±10 %) ;
mesures sur le ZIP produit : pixel de coin identique sur toutes les frames, centroïdes alignés à
quelques pixels, variance de couleur du personnage fortement réduite. Test UI Playwright du flux
en deux étapes.

## Coût

+1 image (gabarit) par personnage + surcoût `input_fidelity: "high"` (tokens d'entrée, visibles
dans `usage`). Post-traitement local gratuit (~quelques dizaines de ms par frame).
