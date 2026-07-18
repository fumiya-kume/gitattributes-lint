# gitattributes-lint

A semantic linter for `.gitattributes` files, powered by Git's attribute
resolution engine.

`gitattributes-lint` validates attribute syntax and built-in values, warns about
likely typos and unused patterns, and reports the effective attributes Git sees
across a repository. Custom attributes remain valid.

## Requirements

- Node.js 20 or later
- Git available on `PATH`

## Installation

Install the package globally:

```sh
npm install --global @fumiya-kume/gitattributes-lint
```

Or add it to a project and run the local binary:

```sh
npm install --save-dev @fumiya-kume/gitattributes-lint
npx gitattributes-lint
```

## Quick start

Run the linter from a repository containing a `.gitattributes` file:

```sh
gitattributes-lint
```

A valid file prints:

```text
true
```

Diagnostics include the file, source location, severity, and rule name:

```text
/repo/.gitattributes:2:7 error gitattributes/invalid-eol-value: eol must be either lf or crlf, received "windows".
1 error(s), 0 warning(s)
```

When no path is supplied, the linter checks `.gitattributes` in the selected
working directory first. If it is absent, the repository-root `.gitattributes`
is used. An explicit path is read directly.

## CLI

```text
gitattributes-lint [options] [path]
```

| Option | Description |
| --- | --- |
| `-C, --cwd <directory>` | Select the working directory used for file and repository discovery. |
| `-f, --format <format>` | Select `stylish` (default) or `json` output. |
| `--strict` | Treat warnings as failures. |
| `--allow-attribute <name>` | Suppress typo warnings for a custom attribute; repeat for multiple names. |
| `--no-config` | Explicitly disable JavaScript configuration loading. |
| `-V, --version` | Print the installed version. |
| `-h, --help` | Print CLI help. |

Examples:

```sh
# Check the default .gitattributes file.
gitattributes-lint

# Check a specific file.
gitattributes-lint path/to/.gitattributes

# Run as though invoked from another repository.
gitattributes-lint --cwd path/to/repository

# Produce machine-readable output and fail on warnings.
gitattributes-lint --format json --strict

# Allow legitimate custom names that resemble built-in attributes.
gitattributes-lint \
  --allow-attribute diff2 \
  --allow-attribute text2
```

For an untrusted repository, make the configuration policy explicit:

```sh
gitattributes-lint --no-config --strict --format json
```

The current release does not auto-load JavaScript configuration files.
`--no-config` records that choice in JSON output and reserves the behavior for
future configuration support; JSON configuration is not implemented yet.

## What it checks

The parser recognizes set, unset, value, and unspecified attribute states,
custom macros, comments, and Git-style C-quoted tokens. It reports errors for:

- malformed rules, quoted tokens, attribute names, or macro names;
- negative patterns, which Git does not support in `.gitattributes`;
- assignments in Git's reserved `builtin_*` namespace;
- `eol` values other than `lf` or `crlf`;
- `text` values other than `auto`;
- missing values for `working-tree-encoding`;
- non-positive `conflict-marker-size` values; and
- inputs or Git results that exceed a resource limit.

Warnings report:

- a custom attribute with one unique built-in name within Levenshtein distance
  2;
- `working-tree-encoding` without an explicit `text` policy in the same rule;
- `binary` combined with `text`, `diff`, or `merge`; and
- a pattern that matches none of the checked repository paths.

Warnings do not fail the command unless `--strict` is used. Custom attributes
are accepted by default because Git allows repositories to define them. Use
`--allow-attribute` only when a legitimate custom name triggers a typo warning.

The built-in catalog covers `text`, `eol`, `crlf`, `working-tree-encoding`,
`ident`, `filter`, `diff`, `merge`, `conflict-marker-size`, `whitespace`,
`export-ignore`, `export-subst`, `delta`, `encoding`, and the `binary` macro.

## Git-aware analysis

When the selected file belongs to a Git repository, the linter streams tracked
paths and untracked, non-ignored working-tree paths through:

```sh
git check-attr --all --stdin -z
```

This provides the effective built-in and custom attributes returned by Git,
including values inherited from Git's normal attribute sources. It also allows
the linter to warn about patterns that match no checked path. Outside a Git
repository, the selected file is still parsed and validated, but effective
attribute and unused-pattern analysis is skipped.

Path and attribute output is consumed as a NUL-delimited stream. The linter
retains counts, unique effective attribute names, and matched rules rather than
the complete repository path and attribute result sets.

## Output and exit codes

| Result | Exit code |
| --- | ---: |
| No errors | `0` |
| Warnings without `--strict` | `0` |
| Errors | `1` |
| Warnings with `--strict` | `1` |
| Missing input, Git failure, or resource failure | `1` |

JSON output includes:

- the resolved file and configuration mode;
- declared built-in and custom attribute names;
- effective built-in and custom attribute names;
- checked-path and effective-attribute counts;
- errors, warnings, and unused patterns; and
- `valid`, which reflects the selected strictness policy.

## Security and resource limits

The linter reads the selected `.gitattributes` file but not the contents of
other working-tree files. Git may inspect its index, configuration, and normal
attribute sources while resolving effective attributes.

Git is invoked with an argument array and `shell: false`. Attribute drivers are
not executed: the linter does not run `filter.*.clean`, `filter.*.smudge`,
`filter.*.process`, `diff.*.command`, or `merge.*.driver`.

Each analysis request shares these primary limits:

- 30-second elapsed-time deadline;
- 1 MiB `.gitattributes` input, 16 KiB per line, 50,000 lines, 25,000 rules,
  100,000 parsed attributes, and 4 KiB per attribute value;
- 24 MiB parser-retained-memory budget;
- 64 MiB aggregate Git stream budget, 100,000 paths, 16 KiB per path or field,
  and 1,000,000 effective attribute results;
- 5,000,000 repository pattern checks and 5,000,000 matcher operations; and
- 1,000 retained diagnostics.

The bounded matcher supports literals, character classes, `*`, `?`, and
recursive `**` globs without constructing a backtracking regular expression.
Exceeding a limit fails closed with a `resource-limit` diagnostic or resource
error and exit code `1`.

## Development

Install dependencies and run the complete local checks:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run check:package
```

After building, exercise the local CLI with:

```sh
node dist/cli.js --help
node dist/cli.js
node dist/cli.js path/to/.gitattributes
node dist/cli.js --format json --strict
```

`npm run test:coverage` writes text, JSON summary, LCOV, and HTML reports to
`coverage/`. CI publishes that directory as an artifact for every supported
Node.js version.

## License

Licensed under the [Apache License 2.0](LICENSE).
