# swarm-monitor

Real-time swarm monitoring.

## Usage
```bash
npx @claude-flow/cli@3.38.12 swarm monitor [options]
```

## Options
- `--interval <ms>` - Update interval
- `--metrics` - Show detailed metrics
- `--export` - Export monitoring data

## Examples
```bash
# Start monitoring
npx @claude-flow/cli@3.38.12 swarm monitor

# Custom interval
npx @claude-flow/cli@3.38.12 swarm monitor --interval 5000

# With metrics
npx @claude-flow/cli@3.38.12 swarm monitor --metrics
```
