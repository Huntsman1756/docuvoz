// Type declarations for vendored foliate-js modules
declare module "../vendor/foliate-js/epub.js" {
  export class EPUB {
    constructor(loader: {
      loadText: (name: string) => Promise<string | null>;
      loadBlob: (name: string, type?: string) => Promise<Blob | null>;
      getSize: (name: string) => number;
    });
    init(): Promise<EPUBBook>;
  }
}

interface EPUBBook {
  metadata?: {
    title?: string | Record<string, string>;
    author?: string | Array<{ name?: string | Record<string, string> }>;
    language?: string | string[];
    description?: string;
  };
  dir?: string;
  toc?: Array<{
    label?: string;
    href?: string;
    subitems?: unknown[];
  }>;
  sections: Array<{
    id?: string;
    linear?: string;
    createDocument(): Promise<Document | null>;
  }>;
  destroy?(): void;
}
