# Classification evaluation

`synthetic/files/` contains only invented examples. Real source files, manifests, human labels, context snapshots and evaluation databases belong in ignored `evaluation-data/`; reports belong in ignored `output/`.

Create a free local demonstration:

```powershell
npm run eval:manifest -- --root evaluation/synthetic/files --dataset-id synthetic-demo --output evaluation-data/synthetic/manifest.json
npm run eval:label -- --manifest evaluation-data/synthetic/manifest.json --labels evaluation-data/synthetic/labels.json --context evaluation-data/synthetic/context.json
```

The label file starts empty. Synthetic examples are not evidence of real classification accuracy. See [the Phase 0.1 guide](../docs/PHASE_0_1_VALIDATION.md) for real labeling, safe runs, comparison and interpretation.
