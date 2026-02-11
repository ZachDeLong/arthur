import chalk from "chalk";

/** Create a text handler that writes streaming text to stdout with formatting. */
export function createRenderer(): {
  onText: (text: string) => void;
  getFullText: () => string;
} {
  const chunks: string[] = [];
  let started = false;

  return {
    onText(text: string): void {
      if (!started) {
        console.log(chalk.bold.cyan("\n── Verification Feedback ──\n"));
        started = true;
      }
      chunks.push(text);
      process.stdout.write(text);
    },
    getFullText(): string {
      return chunks.join("");
    },
  };
}
