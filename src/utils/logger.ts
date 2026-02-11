import chalk from "chalk";

export function info(msg: string): void {
  console.log(chalk.blue("ℹ"), msg);
}

export function success(msg: string): void {
  console.log(chalk.green("✔"), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow("⚠"), msg);
}

export function error(msg: string): void {
  console.error(chalk.red("✖"), msg);
}

export function dim(msg: string): void {
  console.log(chalk.dim(msg));
}

export function heading(msg: string): void {
  console.log(chalk.bold.cyan(`\n${msg}`));
  console.log(chalk.dim("─".repeat(Math.min(msg.length + 4, 60))));
}
