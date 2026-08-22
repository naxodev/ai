import { describe, expect } from "bun:test"
import * as path from "node:path"
import { Effect } from "effect"
import { globalConfigPath, projectConfigPath } from "../domain/paths.ts"
import { toToolResult } from "../errors.ts"
import { expectFailure } from "../test/expect-failure.ts"
import { makeFakeFileSystem } from "../test/fake-file-system.ts"
import { itEffect } from "../test/it-effect.ts"
import { setupWorkflow, type SetupDeps } from "./setup.ts"
import { PERSISTED_INPUT_MAX_BYTES } from "../services/file-system.ts"

const ROOT = "/proj"

function fakeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    onPath: () => true,
    materializeRoleAgentDir: () => "/fake/agent-dir",
    ...overrides,
  }
}

function onPathFrom(bins: Record<string, boolean>): (bin: string) => boolean {
  return (bin) => bins[bin] ?? false
}

function workflowLayer(fakeFs: ReturnType<typeof makeFakeFileSystem>) {
  return { layer: fakeFs.layer }
}

describe("setupWorkflow (fake FileSystem)", () => {
  itEffect("all agent CLIs missing → ConfigError before writing config", () => {
    const fsFake = makeFakeFileSystem()
    const { layer } = workflowLayer(fsFake)
    const deps = fakeDeps({ onPath: onPathFrom({}) })
    return Effect.gen(function* () {
      const r = yield* Effect.result(setupWorkflow({}, ROOT, deps))
      const e = expectFailure(r, "ConfigError")
      expect(e.message).toBe(
        "no supported agent CLI on PATH — install pi, claude, or codex before apnea setup",
      )
      // A refusal that half-writes a config would be worse than the refusal.
      expect(fsFake.files.size).toBe(0)
      // Neither path nor details set here — toToolResult must still yield
      // data: undefined rather than an empty object.
      expect(toToolResult(e).data).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "claude alone produces runnable defaults without Pi profiles",
    () => {
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ claude: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = JSON.parse(fsFake.files.get(globalConfigPath())!)
        expect(written.profiles["pi-grok"]).toBeUndefined()
        expect(written.roles).toEqual({
          orchestrator: { profile: "claude-fable" },
          planner: { profile: "claude-fable" },
          reviewer: { profile: "claude-fable" },
          coder: { profile: "claude-fable" },
        })
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "happy path: global config written with trailing newline; detected reflects deps.onPath; exact payload keys",
    () => {
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true, claude: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(Object.keys(result.data ?? {}).sort()).toEqual(
            [
              "global",
              "project",
              "detected",
              "roles",
              "notes",
              "role_agent_dir",
              "next",
            ].sort(),
          )
          expect(result.data?.detected).toEqual({
            pi: true,
            claude: true,
            codex: false,
            herdr: false,
            jj: false,
            git: false,
          })
        }
        const gPath = globalConfigPath()
        expect(fsFake.files.get(gPath)?.endsWith("\n")).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "project:true writes .apnea/config.json with roles only — no cmd/profiles (the config trust model is the whole point of the split)",
    () => {
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({ project: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const pPath = projectConfigPath(ROOT)
        if (result.ok) expect(result.data?.project).toBe(pPath)
        const body = fsFake.files.get(pPath)
        expect(body).toBeDefined()
        const parsed = JSON.parse(body!)
        expect(Object.keys(parsed)).toEqual(["roles"])
        expect(parsed.roles.coder).toEqual({ profile: "pi-grok" })
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("project omitted: no project file written, project:null", () => {
    const fsFake = makeFakeFileSystem()
    const { layer } = workflowLayer(fsFake)
    const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
    return Effect.gen(function* () {
      const result = yield* setupWorkflow({}, ROOT, deps)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data?.project).toBeNull()
      expect(fsFake.files.has(projectConfigPath(ROOT))).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "pre-existing config keeps custom profiles but drops retired pane_style",
    () => {
      const gPath = globalConfigPath()
      const prevConfig = {
        profiles: { custom: { cmd_interactive: ["custom"] } },
        roles: { coder: { profile: "custom" } },
        pane_style: "floating",
      }
      const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) })
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = JSON.parse(fsFake.files.get(gPath)!)
        expect(written.profiles.custom).toBeDefined()
        expect(written.roles).toEqual({ coder: { profile: "custom" } })
        expect("pane_style" in written).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "force:true replaces profiles/roles and drops retired pane_style",
    () => {
      const gPath = globalConfigPath()
      const prevConfig = {
        profiles: { custom: { cmd_interactive: ["custom"] } },
        roles: { coder: { profile: "custom" } },
        pane_style: "floating",
      }
      const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) })
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({ force: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = JSON.parse(fsFake.files.get(gPath)!)
        expect(written.profiles.custom).toBeUndefined()
        expect(written.roles).toEqual({
          orchestrator: { profile: "pi-grok" },
          planner: { profile: "pi-default" },
          reviewer: { profile: "pi-default" },
          coder: { profile: "pi-grok" },
        })
        expect("pane_style" in written).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "malformed pre-existing global JSON is unchanged unless a human forces replacement",
    () => {
      const gPath = globalConfigPath()
      const malformed = "{not json\n"
      const fsFake = makeFakeFileSystem({ [gPath]: malformed })
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const refused = yield* Effect.result(setupWorkflow({}, ROOT, deps))
        const error = expectFailure(refused, "ConfigError")
        expect(error.message).toContain("--force")
        expect(fsFake.files.get(gPath)).toBe(malformed)

        const result = yield* setupWorkflow({ force: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = JSON.parse(fsFake.files.get(gPath)!)
        expect(written.roles).toEqual({
          orchestrator: { profile: "pi-grok" },
          planner: { profile: "pi-default" },
          reviewer: { profile: "pi-default" },
          coder: { profile: "pi-grok" },
        })
        expect(result.data?.replaced_malformed_global).toBe(true)
        if (result.ok) {
          expect(result.message).toContain("replaced malformed global config")
        }
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("malformed existing project config fails closed", () => {
    const pPath = projectConfigPath(ROOT)
    const malformed = "{broken project\n"
    const fsFake = makeFakeFileSystem({ [pPath]: malformed })
    const { layer } = workflowLayer(fsFake)
    const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        setupWorkflow({ project: true }, ROOT, deps),
      )
      expectFailure(result, "ConfigError")
      expect(fsFake.files.get(pPath)).toBe(malformed)
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "materializeRoleAgentDir throwing → role_agent_dir:null + note; setup still ok (a broken agent dir must not brick setup)",
    () => {
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({
        onPath: onPathFrom({ pi: true }),
        materializeRoleAgentDir: () => {
          throw new Error("boom")
        },
      })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.data?.role_agent_dir).toBeNull()
          expect(result.data?.notes).toContain("role agent dir failed: boom")
        }
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "setup detects Herdr without provisioning or reporting a plugin",
    () => {
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        expect(result.data?.detected).toMatchObject({ herdr: true })
        expect("herdr_version" in (result.data ?? {})).toBe(false)
        expect("herdr_plugin" in (result.data ?? {})).toBe(false)
        expect(
          [...fsFake.files.keys()].some((file) => file.includes("plugin")),
        ).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "--agents-md writes a loop primer naming the CLI, not tool names",
    () => {
      // A harness with no Apnea plugin learns the loop from AGENTS.md or not
      // at all; the primer must name real commands, not tool names.
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({ agents_md: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = fsFake.files.get(path.join(ROOT, "AGENTS.md"))
        expect(written).toBeDefined()
        expect(written).toContain("apnea dispatch")
        expect(written).toContain("apnea wait")
        expect(written).not.toContain("dispatch_role")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "--agents-md appends rather than clobbering an existing file",
    () => {
      // Repos commonly already have AGENTS.md; destroying it would be a
      // data-loss bug disguised as setup.
      const agentsPath = path.join(ROOT, "AGENTS.md")
      const fsFake = makeFakeFileSystem({
        [agentsPath]: "# Existing\n\nkeep me\n",
      })
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({ agents_md: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = fsFake.files.get(agentsPath)!
        expect(written).toContain("keep me")
        expect(written).toContain("apnea dispatch")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("--agents-md refuses an oversized existing file unchanged", () => {
    const agentsPath = path.join(ROOT, "AGENTS.md")
    const existing = "x".repeat(PERSISTED_INPUT_MAX_BYTES + 1)
    const fsFake = makeFakeFileSystem({ [agentsPath]: existing })
    const { layer } = workflowLayer(fsFake)
    const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        setupWorkflow({ agents_md: true }, ROOT, deps),
      )
      const error = expectFailure(result, "ConfigError")
      expect(error.message).toContain("byte limit")
      expect(fsFake.files.get(agentsPath)).toBe(existing)
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "--agents-md re-run replaces only the marker block, not the whole file",
    () => {
      // Marker-guarded merge is the whole point: prove re-running setup
      // doesn't duplicate the section or eat unrelated content around it.
      const agentsPath = path.join(ROOT, "AGENTS.md")
      const fsFake = makeFakeFileSystem()
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        yield* setupWorkflow({ agents_md: true }, ROOT, deps)
        const firstWrite = fsFake.files.get(agentsPath)!
        fsFake.files.set(
          agentsPath,
          `# Notes\n\nabove\n\n${firstWrite}\nbelow\n`,
        )
        const result = yield* setupWorkflow({ agents_md: true }, ROOT, deps)
        expect(result.ok).toBe(true)
        const written = fsFake.files.get(agentsPath)!
        const occurrences = written.split("apnea:begin").length - 1
        expect(occurrences).toBe(1)
        expect(written).toContain("above")
        expect(written).toContain("below")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "prev.roles malformed without force → still ok, with the validation note present",
    () => {
      const gPath = globalConfigPath()
      // missing required "profile" — decodeGlobalConfig must reject this
      const prevConfig = { roles: { coder: {} } }
      const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) })
      const { layer } = workflowLayer(fsFake)
      const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) })
      return Effect.gen(function* () {
        const result = yield* setupWorkflow({}, ROOT, deps)
        expect(result.ok).toBe(true)
        if (result.ok) {
          const notes = (result.data?.notes ?? []) as string[]
          expect(notes.some((n) => n.includes("does not validate"))).toBe(true)
        }
      }).pipe(Effect.provide(layer))
    },
  )
})
