/**
 * Agent-facing instructions returned by the `get_snapshot_checklist` tool.
 * Kept deliberately tool-agnostic: any MCP-capable agent should be able to
 * follow it with its own shell access.
 */
export const SNAPSHOT_CHECKLIST = `# How to collect an environment snapshot

Collect the following on THIS machine, then call the \`push_snapshot\` tool with the result.

## Rules (important)

- NEVER include the VALUES of environment variables, tokens, passwords, or the contents of .env files. Only variable NAMES are allowed in \`envVarNames\`.
- Only collect what is relevant to the current repository; skip anything that would take more than a few seconds.
- Do not guess versions — run the commands and use their real output.

## What to collect

1. \`os\`: platform, arch, OS release.
   - Any OS with node: \`node -p "process.platform + ' ' + process.arch + ' ' + require('os').release()"\`
2. \`runtimes\`: versions of runtimes the repo actually uses. Detect from repo files:
   - package.json → \`node --version\`
   - pyproject.toml / requirements.txt → \`python --version\`
   - go.mod → \`go version\`
   - Cargo.toml → \`rustc --version\`
   - pom.xml / build.gradle → \`java -version\`
3. \`packageManagers\`: e.g. \`npm --version\`, \`pnpm --version\`, \`yarn --version\`, \`pip --version\`, \`uv --version\` — only the ones the repo uses.
4. \`lockfiles\`: for each lockfile present (package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock, uv.lock, go.sum, Cargo.lock):
   - \`git hash-object <file>\` — identical command on every OS, content-stable hash.
5. \`envVarNames\`: names only.
   - bash/zsh: \`env | cut -d= -f1\`
   - PowerShell: \`(Get-ChildItem env:).Name\`
   - PLUS the key names from the repository's LOCAL dotenv files (\`.env\`, \`.env.local\`,
     \`.env.<environment>.local\`): the left-hand side of each KEY=VALUE line. Local env files
     are where "works on my machine" differences hide. Never read values into the snapshot.
   - SKIP committed templates — \`.env.example\`, \`.env.sample\`, \`.env.template\`, \`.env.dist\`,
     and anything else git tracks. They are byte-identical on every machine, so folding their
     keys into this list cannot reveal a difference, only hide one: the key that is present in
     one developer's \`.env\` and missing from another's is in the template on both sides, and
     the diff then reports nothing. \`git check-ignore -q <file>\` answers which is which.
6. \`git\`:
   - branch: \`git branch --show-current\`
   - sha: \`git rev-parse HEAD\`
   - dirtyFiles: paths from \`git status --porcelain\` (paths only)
   - aheadBehind: \`git rev-list --left-right --count @{upstream}...HEAD\` (format "behind ahead"; skip if no upstream)
7. \`shell\`, \`locale\`, \`timezone\`:
   - timezone: \`node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"\`
8. \`collectedAt\`: current time as an ISO-8601 string.

## Then push

Call \`push_snapshot\` with:
- \`repo\`: a stable repository identifier — use the last path segment of the origin remote (e.g. "billing-api" for git@github.com:acme/billing-api.git).
- \`team\`: your team slug (optional if you belong to exactly one team).
- \`device\`: a short, stable name for THIS machine, e.g. "macbook" or "win-desktop" (letters, digits, "-", "_", "."). Every machine keeps its own snapshot slot, so your human's laptop never overwrites their desktop. Ask your human what to call this machine if it is not obvious; the default is the name of the token you authenticate with.
- \`snapshot\`: the object described above.

After pushing, teammates' agents can run \`compare_env\` against you — and you can diff two machines of your own human with \`compare_env {"device":"macbook","their_device":"win-desktop"}\`.`;
