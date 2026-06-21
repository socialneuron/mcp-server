// Ambient declarations for OPTIONAL, dynamically-imported modules that are not
// listed in package.json dependencies. These features (browser screenshots via
// Playwright, local Remotion rendering) are loaded lazily with `await import(...)`
// inside try/catch and degrade gracefully when the package is absent, so the
// packages are intentionally not installed in the default footprint.
//
// Without these shims `tsc --noEmit` fails with TS2307 ("Cannot find module").
// They resolve the imported surface to `any`, which matches the runtime contract
// (the code already guards for the modules being missing). The production build
// uses esbuild with `--packages=external`, so these never affect shipped output.

declare module 'playwright' {
  export type Browser = any;
  export type Page = any;
  export const chromium: any;
  const _default: any;
  export default _default;
}

declare module '@remotion/bundler' {
  export const bundle: any;
  const _default: any;
  export default _default;
}

declare module '@remotion/renderer' {
  export const renderMedia: any;
  export const selectComposition: any;
  const _default: any;
  export default _default;
}
