# smart-spawn

Intelligently spawn agents based on workload analysis.

## Usage
```bash
npx @claude-flow/cli@3.38.12 automation smart-spawn [options]
```

## Options
- `--analyze` - Analyze before spawning
- `--threshold <n>` - Spawn threshold
- `--topology <type>` - Preferred topology

## Examples
```bash
# Smart spawn with analysis
npx @claude-flow/cli@3.38.12 automation smart-spawn --analyze

# Set spawn threshold
npx @claude-flow/cli@3.38.12 automation smart-spawn --threshold 5

# Force topology
npx @claude-flow/cli@3.38.12 automation smart-spawn --topology hierarchical
```
