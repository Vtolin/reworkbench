// citeproc-js (npm `citeproc`) ships no TypeScript declarations.
declare module "citeproc" {
  export class Engine {
    constructor(sys: {
      retrieveLocale: (lang: string) => string | false;
      retrieveItem: (id: string | number) => Record<string, unknown>;
    }, styleXml: string, lang?: string, forceLang?: boolean);
    updateItems(ids: Array<string | number>): void;
    makeBibliography(): [Record<string, string>, string[]];
    setOutputFormat(format: "html" | "text" | "rtf"): void;
  }
}
