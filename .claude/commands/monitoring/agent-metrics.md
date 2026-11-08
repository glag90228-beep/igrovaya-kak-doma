# agent-metrics

View agent performance metrics.

## Usage
```bash
npx @claude-flow/cli@3.38.12 agent metrics [options]
```

## Options
- `--agent-id <id>` - Specific agent
- `--period <time>` - Time period
- `--format <type>` - Output format

## Examples
```bash
# All agents metrics
npx @claude-flow/cli@3.38.12 agent metrics

# Specific agent
npx @claude-flow/cli@3.38.12 agent metrics --agent-id agent-001

# Last hour
npx @claude-flow/cli@3.38.12 agent metrics --period 1h
```
