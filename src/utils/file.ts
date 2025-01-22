import fs from "node:fs";
import path from "node:path";

export enum FileFormat {
  json = "json",
}

/**
 * Parse file contents as Json.
 */
export function parse<T>(contents: string, fileFormat: FileFormat): T {
  switch (fileFormat) {
    case FileFormat.json:
      return JSON.parse(contents) as T;
    default:
      return contents as unknown as T;
  }
}

/**
 * Stringify file contents.
 */
export function stringify(obj: unknown, fileFormat: FileFormat): string {
  let contents: string;
  switch (fileFormat) {
    case FileFormat.json:
      contents = JSON.stringify(obj, null, 2);
      break;
    default:
      contents = obj as unknown as string;
  }
  return contents;
}

/**
 * Read a JSON serializable object from a file
 *
 * Parse either from json, yaml, or toml
 * Optional acceptedFormats object can be passed which can be an array of accepted formats, in future can be extended to include parseFn for the accepted formats
 */
export function readFile<T>(filepath: string, acceptedFormats?: string[]): T {
  const fileFormat = path.extname(filepath).substr(1);
  if (acceptedFormats && !acceptedFormats.includes(fileFormat))
    throw new Error(`UnsupportedFileFormat: ${filepath}`);
  const contents = fs.readFileSync(filepath, "utf-8");
  return parse(contents, fileFormat as FileFormat);
}