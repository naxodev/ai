import { readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runBoundedCommand } from "./bounded-process"

export const workspaceRoot = fileURLToPath(new URL("..", import.meta.url))
const generatedDirectories = new Set([
  "node_modules",
  "dist",
  ".git",
  ".jj",
  ".nx",
  ".apnea",
])

/** Enumerate source independently of tsconfig includes, so omitted tests fail. */
export async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !generatedDirectories.has(entry.name))
        await visit(path)
      else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name))
        files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

export async function checkCoverage(
  root: string,
  files: string[],
): Promise<number> {
  const projects = new Map<string, string[]>()
  for (const file of files) {
    let directory = dirname(file)
    while (!(await Bun.file(join(directory, "tsconfig.json")).exists())) {
      if (directory === resolve(root))
        throw new Error(`No TypeScript project owns ${relative(root, file)}`)
      directory = dirname(directory)
    }
    const project = join(directory, "tsconfig.json")
    const members = projects.get(project) ?? []
    members.push(file)
    projects.set(project, members)
  }
  for (const [project, members] of projects) {
    const result = await runBoundedCommand(
      [
        "bun",
        "run",
        resolve(workspaceRoot, "node_modules/typescript/bin/tsc"),
        "--listFilesOnly",
        "--project",
        project,
      ],
      {
        cwd: root,
        label: `lint coverage: ${project}`,
        timeoutMs: 60_000,
        outputLimitBytes: 8 * 1024 * 1024,
      },
    )
    if (result.exitCode !== 0) throw new Error(result.stdout + result.stderr)
    const included = new Set(
      result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((file) => resolve(root, file)),
    )
    const omitted = members.filter((file) => !included.has(resolve(file)))
    if (omitted.length)
      throw new Error(
        `Type-aware lint coverage missing from ${relative(root, project)}:\n${omitted.map((file) => relative(root, file)).join("\n")}`,
      )
  }
  return projects.size
}

export async function lint(root = workspaceRoot) {
  const files = await sourceFiles(root)
  if (!files.length) throw new Error("No TypeScript source files found")
  const projects = await checkCoverage(root, files)
  const result = await runBoundedCommand(
    [
      "bun",
      "run",
      resolve(workspaceRoot, "node_modules/oxlint/bin/oxlint"),
      "--config",
      resolve(workspaceRoot, ".oxlintrc.json"),
      "--disable-nested-config",
      "--no-ignore",
      "--deny-warnings",
      ...files,
    ],
    {
      cwd: workspaceRoot,
      label: "async correctness lint",
      timeoutMs: 120_000,
      outputLimitBytes: 8 * 1024 * 1024,
    },
  )
  return { ...result, files: files.length, projects }
}

if (import.meta.main) {
  const result = await lint()
  console.log(
    `Async lint coverage: ${result.files} TypeScript/TSX files in ${result.projects} projects`,
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}
