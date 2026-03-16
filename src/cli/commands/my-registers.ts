import type { Command } from "commander";

import { createCommandAction } from "../context.js";

interface MyRegistersOptions {
  name?: string;
}

export function registerMyRegistersCommand(program: Command): void {
  program
    .command("my-registers")
    .description("Lista os registers disponíveis para o usuário autenticado")
    .option("--name <search>", "Filtra summaries por nome/título do register")
    .action(
      createCommandAction(async ({ kit }, options: MyRegistersOptions) => {
        const result = await kit.contracts.getMyRegisters();
        const search = options.name?.trim().toLowerCase();
        const summaries = search
          ? result.summaries.filter((item) => (item.title ?? "").toLowerCase().includes(search))
          : result.summaries;

        return {
          raw: result.raw,
          summaries,
          total: summaries.length
        };
      })
    );
}
