import dotenv from "dotenv";

let loaded = false;

export function loadEnv(path?: string): void {
  if (loaded) {
    return;
  }
  dotenv.config(path ? { path } : undefined);
  loaded = true;
}
