# Long-transcript benchmark

This benchmark compares the stock renderer at `d981de1229ef899957bbe968bc8dcda02a21f477` with a selected JetPi revision. It uses the deterministic synthetic 422-Tool-Call fixture. It does not read session files.

Each warm-up and measured sample runs in a fresh Node.js worker. The worker measures these phases separately:

- transcript and component construction
- first render at 77×35
- width resize and render at 118×35

Each phase reports wall time and CPU user, system, and total time. The driver prints every sample plus median, minimum, and maximum values. Timing values are descriptive. They never cause a failure.

The command fails only when a target root or exact revision is invalid, a worker fails, or structural correctness fails. Structural checks derive entry, Tool Call, result, group, and singleton counts from the restored transcript and component tree. They also cover one resize render per Tool Call, marker ordering, cursor position, and destructive width-redraw control sequences.

## Run

Create a detached stock worktree without changing its source:

```sh
git worktree add --detach /tmp/pi-stock-d981de122 d981de122
npm --prefix packages/coding-agent run benchmark:long-transcript -- \
  --stock-root /tmp/pi-stock-d981de122 \
  --jetpi-revision "$(git rev-parse HEAD)" \
  --warmups 1 \
  --samples 3
```

Use `--output <path>` to select the JSON artifact path. The default is under `packages/coding-agent/.artifacts/`, which Git ignores. The artifact contains only runtime metadata, safe target labels, revisions, package versions, geometry, observed aggregate counts, a fixture hash, measurements, and structural results. It does not contain target roots, absolute paths, transcript text, or private session data.
