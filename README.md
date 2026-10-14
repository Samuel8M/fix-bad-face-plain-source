# Fix Bad Face Plain

The control version of [Fix Bad Face](https://samuel8m.github.io/good-take/): the same app with the **analogy methods taken out**, so the two can be compared.

**Use it:** https://samuel8m.github.io/fix-bad-face-plain/

It matches people the conventional way a camera-burst feature such as Google's Best Take can, because burst shots come from one phone a few seconds apart:

- **Line up the shots** by conventional image registration: the pan and zoom that best line up the pixels of the two whole images.
- **Who is who:** each face pairs with the face at the same place, after lining up, that also looks most alike (face texture, hair, skin and clothing colour), one-to-one.
- **Best take:** every match is scored once on open eyes, sharpness, smile, head angle, size and match confidence.

Everything else is identical to Fix Bad Face: face finding, the face-swap compositing, the screens, saving, and the home-screen app.

## What was removed

| In Fix Bad Face | In Plain |
|---|---|
| **Structure-mapping correspondence.** Look-alike cues only propose pairings. The winner is the camera shift that the *whole group's arrangement* agrees with (systematicity), solved one-to-one. | The shift comes from the image pixels. Each face is then placed on its own. |
| **Relational signature** of each face: how the eyes, nose, mouth and chin sit relative to each other. | Not computed. |
| **MAC/FAC retrieval:** a cheap score shortlists takes, then a structural comparison ranks the top three. | One pass. The same weights, with the structural term removed and the rest rescaled. |

Google has not published how Best Take works inside, and it also uses trained blending models that are not reproduced here. So this is a conventional baseline, not a copy of Google's feature. What it isolates is exactly what the analogy methods add.

## Results

Both matchers were run on the very same detected faces, so face detection cannot differ between them. The scripts are in [`compare/`](compare/).

**Camera moved, people did not** (synthetic pans and zooms of 4 real group photos, 32 cases, exact ground truth): **a tie**. Both matched every face correctly in every case. Pure camera motion is exactly what pixel registration solves.

Without any lining up (relying on a still camera), the plain matcher failed from a 3% pan onward. That is why it registers the images first: any burst feature must.

**Real shots of the same moment**, where people also move between shots: 9 shot pairs from Wikimedia Commons (an iPhone pair, 6 handheld night shots of a group of about 20, and a group that swapped places). Every disagreement was checked by eye.

| | Fix Bad Face (analogy) | Plain |
|---|---|---|
| People correctly matched | **105** | 90 |
| Matched to the **wrong person** | **1** | 4 |
| Best-take picks that were the wrong person (one face, six other shots) | **0** | 1 |
| Closed eyes fixed, among the 3 closed-eye faces where the picks differed | **2** | 1 |

When the camera is still (the iPhone pair), both are perfect and identical. The differences appear when people and camera both move. The pixel alignment follows the background, while the analogy aligns on the group itself, so it found more people and pasted far fewer wrong faces. A wrong match is the worst failure: someone else's face on your mom.

The analogy method is not free of mistakes either. In the group that swapped places, it matched one woman to a man where the plain one got it right.

[`compare/amb02-amb05-disagreements.png`](compare/amb02-amb05-disagreements.png) shows the biggest gap. Each row is a face in the main shot, then each method's match in the other shot. A blank means no match. [`compare/best-take-picks.png`](compare/best-take-picks.png) shows each method's chosen best take where they differ.

This is a small test: about 110 face matches on 3 groups. Treat the numbers as a direction, not a benchmark.

## Develop

```sh
npm install
npm run dev          # http://localhost:5189
npm run typecheck
npm run build:pages  # static build with relative paths, for GitHub Pages
```

To rerun the comparison, run Fix Bad Face on port 5174 and this app on 5189. Put the test photos in an `imgs/` folder next to the scripts (the file names are in the scripts; all are from Wikimedia Commons). Then run `node compare/synthetic-moves.cjs` and `node compare/real-pairs.cjs` with `playwright-core` installed.
