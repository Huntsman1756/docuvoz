/**
 * Global mock for DOMPurify in Node.js test environment.
 *
 * DOMPurify requires a browser DOM. In vitest's Node.js environment,
 * we provide a pass-through mock that strips only the most dangerous tags.
 */
const stripDangerous = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "");

const DOMPurify = {
  sanitize: stripDangerous,
};

export default DOMPurify;
