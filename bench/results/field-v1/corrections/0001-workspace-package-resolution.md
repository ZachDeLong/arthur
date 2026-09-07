# Field v1 detector-blind evidence erratum 1

Issued after the preregistered freeze and before any primary-review submission.
The original case inventory, detector predictions, review packets, standard-tool
evidence, and study lock remain unchanged.

## Correction

The package contract embedded in each original import review packet looked only
for `package.json` and `node_modules` at the repository root. That lookup is not
valid for a source file inside a nested npm project or monorepo workspace. In
particular, an embedded `installed: false` value establishes only that the
package was not found at the repository root; it does not establish that the
importing source file could not resolve the package.

For **every** import case in the cohort, reviewers must disregard the embedded
`installed` and `declaredVersion` fields and independently establish resolution
from the importing file's location:

1. Start at the directory containing `location.path` and walk upward through
   the pinned repository state.
2. Inspect the nearest applicable `package.json` and lockfile.
3. Apply normal Node package resolution from that directory, including nested
   or hoisted `node_modules` directories.
4. Use the captured compiler/test/lint output and the packet's immutable public
   commit link as additional evidence.
5. Use `uncertain` if those sources do not establish whether the import
   resolved. Do not infer a label from this erratum.

The route contract in field v1 inventories only Next.js App Router `route.ts`
files, as preregistered. An empty route list must not be interpreted as proof
that a route in another backend framework is missing; such a reference is
outside field v1's Next.js blocking contract and should be reviewed under the
protocol's `ignored` definition.

## Blinding disclosure

The study operator found the package-contract defect during a post-freeze,
non-independent inspection of detector output. This erratum is therefore
applied to all import cases rather than to a detector-selected subset, contains
no Arthur or comparator decisions, and asks reviewers to verify facts directly.
Reviewers must still satisfy the original independence and blinding
attestations.
