# gitattributes-lint

A semantic linter for `.gitattributes` files, powered by Git's attribute resolution engine.

## Status

The CLI and the first semantic lint rules are in place.

The current implementation reads the target file and reports:

- with no path, it checks `.gitattributes` in the current directory first;
- if that file is absent, it checks `.gitattributes` at the repository root;
- with a path, it reads that file directly.

Attribute expressions are classified against Git's built-in attribute catalog.
Custom attributes remain valid because Git supports repository-defined
attributes. Assignments in Git's reserved `builtin_*` namespace are rejected.
The catalog includes `text`, `eol`, `crlf`, `working-tree-encoding`, `ident`,
`filter`, `diff`, `merge`, `conflict-marker-size`, `whitespace`,
`export-ignore`, `export-subst`, `delta`, `encoding`, and the `binary` macro.

When the target file belongs to a Git repository, the file analysis also runs
`git check-attr --all --stdin -z` against the repository's tracked and
non-ignored working-tree paths. This exposes the effective built-in and custom
attributes returned by Git, including attributes inherited from Git's normal
attribute sources.

Git path and attribute output is consumed as a NUL-delimited stream. The
linter does not retain the repository's complete file list or all effective
attribute records in memory; it keeps only counts, effective attribute names,
and the rules matched while paths pass through the stream. The linter reads
the selected `.gitattributes` file only and does not read the contents of
other working-tree files. Git may still inspect its own index, configuration,
and attribute sources while resolving attributes.

The Git integration is read-only with respect to attribute drivers. It does
not execute `filter.*.clean`, `filter.*.smudge`, `filter.*.process`,
`diff.*.command`, or `merge.*.driver`; Git is invoked with an argument array
and `shell: false`.

For an untrusted repository, disable JavaScript configuration explicitly:

```sh
gitattributes-lint --no-config --format json
```

The current release does not auto-load JavaScript configuration files at all;
`--no-config` makes that security decision explicit and is propagated through
the analysis API for future configuration support. A JSON-only configuration
mode is not implemented yet.

Custom attributes remain valid. A warning is emitted only when an attribute is
unknown, has a unique closest built-in attribute, and its Levenshtein distance
is at most 2. Ties and distant candidates are ignored. Explicitly allow a
legitimate custom name when needed:

```sh
gitattributes-lint --allow-attribute vendor-flag
```

The analysis API accepts the same allow list as `allowedAttributes`.

The linter also checks every rule for syntax errors, negative patterns, invalid
built-in values, conflicting `binary` rules, and patterns that match no checked
repository path. Unused patterns are warnings by default; use `--strict` to
make warnings fail the command.

Resource limits protect CI and untrusted-repository runs. Each analysis request
shares a 30-second deadline, a 64 MiB aggregate Git stream budget, a 24 MiB
parser-retained-memory budget, and a 5,000,000-operation pattern-matching
budget. A `.gitattributes` file is limited to 1 MiB, 16 KiB per line, 50,000
lines, 25,000 rules, and 4 KiB per attribute value. Git output is limited to
100,000 paths, 16 KiB per path or field, and 1,000,000 attribute results. The
matcher is an explicit bounded implementation for literals, character classes,
`*`, `?`, and recursive `**` globs; it does not construct a backtracking
`RegExp`. Diagnostics are capped at 1,000 entries; exceeding a limit fails
closed with a `resource-limit` diagnostic or resource error and exit code `1`.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js --help
node dist/cli.js
node dist/cli.js path/to/.gitattributes
node dist/cli.js --format json
node dist/cli.js --strict --format json
```

Exit code `0` means the check passed. Errors return `1`; warnings return `0`
unless `--strict` is specified. JSON output includes declared and effective
built-in/custom attributes, checked path and effective attribute counts,
errors, warnings, and unused patterns.

The published command will be `gitattributes-lint`.
