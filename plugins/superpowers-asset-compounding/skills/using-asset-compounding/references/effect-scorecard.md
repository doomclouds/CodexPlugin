# Asset Compounding Effect Scorecard

Use this after writing or updating an asset, and occasionally when reviewing the
plugin itself. It is not a hard promotion gate.

## Minimal Scorecard

Answer these five checks in one short block:

1. Route quality: was the chosen route more appropriate than `none` or
   `update-existing`?
2. Retrieval value: what exact future query, feature name, or symptom will find
   this asset?
3. Evidence strength: what verification, acceptance, root cause, or uncertainty
   label supports the asset?
4. Cost control: did this use the lightest useful path, or did it create new
   paperwork without future value?
5. Next-session value: what will a future agent avoid re-learning?

## Suggested Output

```text
asset_effect:
  route_quality: <ok | weak | over-promoted>
  retrieval_value: <future lookup key>
  evidence_strength: <verified | accepted | root-cause | uncertain>
  cost_control: <light | acceptable | heavy>
  next_session_value: <one sentence>
```

## Fail Signals

Treat the asset as suspect if any of these are true:

- no realistic future lookup key exists
- the asset repeats the final chat summary without adding retrieval structure
- the route could have been an update to an existing asset
- the only evidence is "it felt important"
- creating the asset took more effort than the knowledge is likely to save
