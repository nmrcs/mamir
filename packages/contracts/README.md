# @mamir/contracts

The domain plugin contract and shared Zod schemas for MAMIR.

## Consumers

`apps/backend` and `plugins/*`. The dependency is declared by name — npm workspaces links the package from the monorepo:

```jsonc
"dependencies": {
  "@mamir/contracts": "*"
}
```

A relative import across the package boundary (`../../packages/contracts/src/...`) is forbidden by a lint rule: consumers read `dist`, so after editing the schemas run `npm run build -w @mamir/contracts`, or `npm run dev -w @mamir/contracts` to watch.

**The core depends on the contracts and never on the plugins.** That is the boundary `npm run boundary` checks from the root of the monorepo.

## The main idea

**A plugin is data, not code.** The contract contains no functions at all: event schema, aggregation axis, event timestamp, exposure, features, label and scenarios are all declared. The core computes everything.

Two properties follow:

- the contract is validated at runtime **as a whole**, cross-references included (`feature.entity` → `entityKeys`, `shift.feature` → `features`, every path → an `event` field). A typo fails at core startup rather than two hours into a backtest;
- a plugin is serializable — an npm package today, a row in the database with a UI editor tomorrow.

**A feature is a window declaration, not a function.** `{ name, entity, source, agg, window }`. There is one definition and it lives in the core, but two execution forms — pointwise for real time, windowed for the backtest. So the guard against train/serve skew does not rest on the claim "there is only one code path" but on checkable equivalence of the two forms: one compiler, one definition, verified on a sample of pairs.

## Contents

- `common.ts` — `Slug`, `Primitive`, `EventSchema`, `TimeSpec`, `AmountSpec`
- `predicate.ts` — `Predicate` (a fixed set of operations, no eval)
- `feature.ts` — `FeatureSpec` (including `where`, the window's event filter), `FeatureAgg`, `FeatureWindow`
- `label.ts` — `LabelSpec` (loss definition plus maturation horizon)
- `scenario.ts` — `ScenarioSpec`, `FieldShock` (a shock on an event field, not on a feature)
- `plugin.ts` — `DomainPlugin` plus cross-validation
- `event.ts` — `IngestEvent`, `IngestResult`
- `score.ts` — `ScoreRequest`, `ScoreResponse`, `LossDistribution` (the contract with `mamir-scoring`: scoring and the portfolio loss distribution)

## Scripts

| Command         | What it does                     |
| --------------- | -------------------------------- |
| `npm run build` | tsup → `dist` (cjs + esm + d.ts) |
| `npm run dev`   | the same, in watch mode          |

Lint and format are run from the monorepo root (`npm run lint`, `npm run format`) — they cover every package at once.
