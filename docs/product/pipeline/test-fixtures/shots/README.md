# Annotation sidecars, tracked on purpose

`shoot.mjs` writes `<id>.marks.json` next to each PNG in `docs/product/shots/`,
which is a build artefact directory and gitignored. `render.test.mjs` needs a
sidecar to assert the renderer's annotation output on, so it reads THIS
directory instead: the files here are tracked, so the test means the same thing
on a clean clone as on a box where the rig has run (trap 62).

Keep them in the shape `shoot.mjs` writes: `{ n, say, sel, x, y, w, h }`, with
the geometry in percentages of the captured image. `render.test.mjs` pins each
fixture's `sel` and `say` against the shot's declaration in `shots.mjs`, so if
you change a shot's marks, regenerate the fixture rather than editing prose in
two places.

Nothing here is a screenshot: no PNG belongs in this directory.
