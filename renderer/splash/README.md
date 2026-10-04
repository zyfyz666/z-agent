# Z startup page

The startup page uses local HTML, CSS and the Z mark. It has no JavaScript,
WebGL, remote font or network request. The small CSS status indicator respects
reduced-motion preferences. The main application defaults to software rendering.

`npm run bundle:splash` validates the files used during packaging.
`node test/splash.e2e.cjs` verifies the isolated Electron startup and handoff.
