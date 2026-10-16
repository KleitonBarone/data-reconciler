# Normalize projected records

Projection maps provider records into comparable fields. Normalization then
defines which differences matter. Both steps preserve the original evidence. The
default `json.v1` policy preserves string case, whitespace, and array order. Use
explicit rules when your domain treats those differences as equivalent.

## Run the example

The [complete job](../examples/normalization.json) compares these synthetic
inputs:

| Value    | [Warehouse JSON](../examples/normalization-source.json) | [Shop JSON](../examples/normalization-target.json) |
| -------- | ------------------------------------------------------- | -------------------------------------------------- |
| Identity | `sku: " shirt-01 "`                                     | `code: "SHIRT-01"`                                 |
| Name     | `product.name: "  Ｂｌｕｅ Shirt  "`                    | `title: "Blue Shirt"`                              |
| Tags     | `product.tags: [" sale ", "blue"]`                      | `labels: ["blue", "sale"]`                         |
| Stock    | `product.stock: 12`                                     | `quantity: 12`                                     |
| Trace    | `trace: "source-only note"`                             | `trace: "target-only note"`                        |

From a repository checkout:

```sh
pnpm dev compare --config examples/normalization.json --store .data/normalization.sqlite --format json
```

The report has one equal record and zero missing, changed, or conflicting
records. Comparison writes checkpoints and evidence to the store; both input
files remain unchanged. With an installed tarball, run `data-reconciler compare`
with `--config` pointing to its `examples/normalization.json`. Paths inside the
job resolve relative to that file.

The [public library example](../examples/consumer.ts) accepts the same job path
and prints the summary. Package tests compile that example against public
exports, run it outside the repository, and check the installed CLI's snapshots
and original evidence.

## Select the projected fields

The source projection maps `"name": "/product/name"`; the target maps
`"name": "/title"`. Both produce the comparable field `name`. Normalization
therefore selects `/name`. A rule for `/product/name` would not match either
projected name.

The job uses this policy:

```json
{
  "version": "inventory-normalization.v1",
  "text": { "trim": true },
  "identities": { "sku": { "trim": true, "case": "upper" } },
  "fields": { "/name": { "trim": true, "unicode": true } },
  "ignore": ["/syncNote"],
  "unorderedArrays": ["/tags"]
}
```

`text` applies to comparable string values, including array elements. Identity
values use their namespace's rule from `identities` instead. Here `sku` values
are trimmed and uppercased, producing the identity key `sku:SHIRT-01`. The
namespace and each compound identity component remain distinct.

A `fields` rule replaces the global `text` rule for that exact string path. The
`/name` rule includes `trim` explicitly and uses Unicode NFKC normalization to
convert fullwidth letters. Case conversion is optional; it does not apply to
object keys or identity namespace names.

`ignore` removes `/syncNote` from the comparable object. It does not remove
`trace` from evidence. Ignore selectors remove object properties, including
properties nested inside arrays; they do not remove array positions.

`unorderedArrays` sorts the normalized `/tags` values deterministically.
Duplicates remain, so `["blue", "blue"]` still differs from `["blue"]`. Arrays
stay ordered unless selected explicitly.

Both comparable snapshots become:

```json
{ "name": "Blue Shirt", "stock": 12, "tags": ["blue", "sale"] }
```

The evidence still contains the padded SKU, fullwidth source name, original tag
order, and each system's trace value. Missing fields remain absent and differ
from explicit JSON null. Normalization preserves JSON types.

Selectors use JSON Pointer. Escape `~` as `~0` and `/` inside a key as `~1`. Use
`/product/name` for a nested field, `/product.name` for a literal key containing
a dot, and `/tags/0` for an exact array element's string rule.

## Version changes and repairs

Policies require a nonempty version. Both policy contents and version
participate in the job fingerprint. After changing rules, use an explicit new
generation rather than resuming incompatible state:

```sh
pnpm dev compare --config examples/normalization.json --store .data/normalization.sqlite --generation normalization-v2 --format json
```

Keep the old generation for its reports and evidence. See
[recovery and upgrades](recovery.md) for rescans.

Normalization also determines comparable values available to repair planning.
Declare [field ownership and acceptance](repairs.md) separately. If a selected
top-level field contains ignored nested data, planning skips that repair rather
than replacing the field and losing raw values.
