import FS from "node:fs/promises";
import Path from "node:path";
import { loadConfig } from "./config.js";
import { Section } from "./utils.js";
import { parse, type File, type FrontMatter } from "./parser/index.js";
import type { Root } from "mdast";
import type { Node } from "unist";

async function* getFiles(
  dir: string,
): AsyncGenerator<[string, File], void, never> {
  const dirents = await FS.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const subPath = Path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(subPath);
    } else if (dirent.name.endsWith(".md")) {
      const source = await FS.readFile(subPath, "utf-8");
      const file = parse(source, subPath);
      yield [subPath, file];
    }
  }
}

if (!process.argv[2]) throw new Error("No content path specified");

const contentPath = Path.resolve(process.cwd(), process.argv[2]);
const javascriptPath = Path.join(contentPath, "files/en-us/web/javascript");

const [allRules, files, config] = await Promise.all([
  Promise.all([
    // Load rules; each import() must take a literal to allow static analysis
    import("./rules/bad-dl.js"),
    import("./rules/class-members.js"),
    import("./rules/data-prop.js"),
    import("./rules/deprecation-note.js"),
    import("./rules/description.js"),
    import("./rules/heading.js"),
    import("./rules/lint.js"),
    import("./rules/spec-alignment.js"),
    import("./rules/structure-consistency/index.js"),
    import("./rules/syntax-section.js"),
  ]),
  Array.fromAsync(getFiles(javascriptPath)),
  loadConfig(),
]);

export const rules = allRules.filter((rule) => config.rules[rule.default.name]);

export const pathToFile = new Map(files);

const descriptions = new Map<string, string>();

export class Context {
  path = "";
  source = "";
  ast!: Root;
  frontMatter!: FrontMatter;
  #currentName = "";
  #reports: { [ruleName: string]: string[] } = {};
  constructor(path: string, file: File) {
    this.path = path;
    Object.assign(this, file);
  }
  setName(name: string): void {
    this.#currentName = name;
  }
  report(message: unknown): void {
    this.#reports[this.#currentName] ??= [];
    this.#reports[this.#currentName]!.push(String(message));
  }
  outputReports(): void {
    if (Object.keys(this.#reports).length === 0) return;
    // TODO VS Code does not support hyperlinks to files (and the macOS Terminal
    // does not support OSC 8 at all!)
    // https://github.com/microsoft/vscode/issues/176812
    console.error(
      `\u001B]8;;${this.path}\u0007${
        this.frontMatter.title
      }\u001B]8;;\u0007: ${Path.relative(process.cwd(), this.path)}`,
    );
    for (const [ruleName, messages] of Object.entries(this.#reports)) {
      console.error(`  [${ruleName}]`);
      for (const message of messages)
        console.error(`    ${message.split("\n").join("\n    ")}`);
    }
  }
  getSource(node: Node | Node[], file: File = this): string {
    const start = Array.isArray(node) ? node[0]! : node;
    const end = Array.isArray(node) ? node.at(-1)! : node;
    return file.source.slice(
      start.position!.start.offset,
      end.position!.end.offset,
    );
  }
  getSubpages(path?: string, options?: { withPath?: false }): File[];
  getSubpages(
    path: string | undefined,
    options: { withPath: true },
  ): [string, File][];
  getSubpages(
    path?: string,
    { withPath = false }: { withPath?: boolean } = {},
  ): ([string, File] | File)[] {
    const subpages: ([string, File] | File)[] = [];
    const basePath = Path.dirname(path ?? this.path);
    for (const [p, file] of pathToFile) {
      if (Path.dirname(Path.dirname(p)) === basePath)
        subpages.push(withPath ? [p, file] : file);
    }
    return subpages;
  }
  getFile(path: string): File | undefined {
    return pathToFile.get(Path.resolve(javascriptPath, path, "index.md"));
  }
  getDescription(
    path: string = Path.dirname(Path.relative(javascriptPath, this.path)),
  ): string {
    let description = descriptions.get(path);
    if (description) return description;
    const file = this.getFile(path);
    if (!file) return "";
    const descriptionNode = file.ast.children.find(
      (node) =>
        node.type === "paragraph" &&
        !/^\{\{.*\}\}$/u.test(this.getSource(node, file)),
    );
    if (!descriptionNode) return "";
    // TODO new lines should be removed from source
    description = this.getSource(descriptionNode, file).replaceAll("\n", " ");
    descriptions.set(path, description);
    return description;
  }
  get tree(): Section {
    return new Section(this.ast.children, this, 2, this.frontMatter.title);
  }
}

export const exitContext = new (class {
  #currentName = "";
  setName(name: string): void {
    this.#currentName = name;
  }
  report(message: unknown): void {
    console.error(
      `[${this.#currentName}]`,
      `${message}`.split("\n").join("\n  "),
    );
  }
})();

export type ExitContext = typeof exitContext;
