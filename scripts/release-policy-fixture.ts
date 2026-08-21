import { ReleaseClient } from "nx/release"

const { projectsVersionData } = await new ReleaseClient({}).releaseVersion({
  specifier: "0.2.0",
  projects: ["apnea", "pi-apnea"],
  dryRun: true,
  stageChanges: false,
  gitCommit: false,
  gitTag: false,
  gitPush: false,
})

console.log(`__NX_RELEASE_RESULT__${JSON.stringify(projectsVersionData)}`)
