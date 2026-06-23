declare module 'playwright' {
  export type Browser = any;
  export type Page = any;
  export const chromium: any;
}

declare module '@remotion/bundler' {
  export const bundle: any;
}

declare module '@remotion/renderer' {
  export const getCompositions: any;
  export const renderMedia: any;
  export const selectComposition: any;
}
