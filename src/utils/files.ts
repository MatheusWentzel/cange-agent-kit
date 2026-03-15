import { promises as fs } from "node:fs";
import path from "node:path";

import { CangeCliUsageError } from "../client/errors.js";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  let content: string;

  try {
    content = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new CangeCliUsageError(`Não foi possível ler o arquivo: ${resolvedPath}`, {
      cause: error
    });
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new CangeCliUsageError(`JSON inválido no arquivo: ${resolvedPath}`, {
      cause: error
    });
  }
}

export function resolveFilePath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}
