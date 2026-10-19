# Jevtool CLI

Test your Jev judgments before you ship them. Check agent deliveries against real test results. Filter records by meaning.

Jev is TypeSafe's System One model: it returns typed answers with probabilities instead of text. Calling it takes five minutes. Knowing whether its answers are right for *your* data takes longer. `jevtool eval` runs your labeled cases through Jev and tells you the accuracy, which cases it misses, which confidence cutoff is safe to automate at, and which answers change when you switch model versions.

Requires Node.js 20+. Git is needed only for `verify`. No runtime dependencies. MIT licensed. Jevtool is an independent project and is not affiliated with TypeSafe AI.

```sh
npm install -g jevtool        # or: npx jevtool ...
export TYPESAFE_API_KEY=...   # from https://console.typesafe.ai
jevtool eval --examples
jevtool eval example:support-triage
```

## Evaluate a judgment

A suite is one JSON file: the questions you send to Jev, and cases with the answers you expect.

```json
{
  "name": "support-triage",
  "model": "jev-1.13.0",
  "target": 0.95,
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "What does the customer who wrote `email` mainly want?",
      "criteria": { "refund": "Money back for a specific past charge.", "howto": "Learn how to do something.", "other": "Anything else." }
    },
    "escalate": { "type": "noul", "instructions": "Does `email` threaten a chargeback or legal action?" }
  },
  "cases": [
    { "id": "s1", "state": { "email": "Charged twice, refund one please." }, "expect": { "category": "refund", "escalate": false }, "tags": ["en"] },
    { "id": "s2", "state": { "email": "Refund or I dispute it with my bank." }, "expect": { "category": "refund", "escalate": true } }
  ]
}
```

`expect` takes an option (or a list of acceptable options) for a Choice, `true`/`false` for a Noul, and a level index for a Score. Leave a question out of `expect`, or set it to `null`, to skip scoring it for that case. `tags` group accuracy, for example by language.

```sh
jevtool eval my-suite.json
jevtool eval my-suite.json --compare jev-1.14.0     # which answers change on the new version
jevtool eval my-suite.json --order-check            # re-ask Choices with options reversed
jevtool eval my-suite.json --min-accuracy 0.9 --json --output eval.json   # CI gate
jevtool eval example:contract-risk --save my-suite.json                   # start from an example
```

For each question the report shows accuracy, accuracy per tag, every miss with its certainty, and a suggested cutoff: the lowest certainty (Choice/Score confidence, or max(p, 1−p) for a Noul) at which the automatically handled cases still reach `target`. Cases below the cutoff are the ones to send to a person or a larger model. It also reports latency, input tokens per call and an estimated cost at list price.

Ten example suites ship with the package: support triage, chat inbound guard, model routing, RAG fact-checking, entity matching, lead routing, review moderation, contract risk, code review lint and inbox triage. Their cases and labels are hand-written smoke tests, not benchmarks. Replace them with your own data.

| Exit code | Eval |
| --- | --- |
| `0` | All requests answered, all questions at or above `--min-accuracy` |
| `1` | At least one question below `--min-accuracy` |
| `2` | Some requests failed; results are partial |
| `3` | Configuration error or every request failed |

**Data sent by `eval`:** each case's `state` and the suite's questions go to TypeSafe. Labels stay local.

## Check an agent delivery

Run from a Git repository with at least one commit:

```sh
jevtool init --task "Reject blank passwords without changing the page styles"
```

Edit `.jevtool/acceptance.json`. Keep requirements small and explicit; bind relevant test commands to the requirements they check. See [examples/acceptance.json](examples/acceptance.json).

```json
{
  "version": 1,
  "task": "Reject blank passwords without changing styles",
  "base": "HEAD",
  "criteria": [
    {
      "id": "login",
      "description": "Whitespace-only passwords are rejected",
      "paths": ["src/login.js"],
      "tests": ["login-tests"]
    },
    {
      "id": "styles",
      "kind": "unchanged",
      "description": "Keep CSS unchanged",
      "paths": ["**/*.css"]
    }
  ],
  "tests": [
    { "id": "login-tests", "command": ["node", "--test", "test/login.test.js"] }
  ]
}
```

Collect local evidence first:

```sh
jevtool verify
jevtool verify --run-tests
```

`--run-tests` executes the commands in the acceptance file in the repository root. Review that file before running it. Commands are argv arrays with no implicit shell; shell operators and expansion are not supported unless you explicitly invoke a shell yourself. Default timeout is 60 seconds per command; configurable range is 100–300000 ms.

To enable semantic checks, set `TYPESAFE_API_KEY` in your environment, then:

```sh
jevtool verify --run-tests --judge
jevtool verify --run-tests --judge --json --output .jevtool/report.json
```

`JEV_API_KEY` is also accepted. The key is never written to a config file. The default model is pinned to `jev-1.13.0`; set `JEV_MODEL` to choose another model.

**Data sent by `--judge`:** task, requirement descriptions, matching changed-file excerpts and linked test outputs. Common credential patterns are redacted, and sensitive paths and symlinks are excluded from semantic approval. This is best-effort redaction, not a comprehensive secret scanner. Without `--judge`, verify makes no model request. Model errors and missing answers remain `review`; they never pass silently.

## Acceptance checks and evidence boundaries

| Kind | Meaning |
| --- | --- |
| `judgment` (default) | Jev checks whether selected diff/test evidence supports the requirement. |
| `changed` | Every configured path pattern must have at least one changed file. This checks presence, not correctness. |
| `unchanged` | No changed file may match the configured path patterns. |
| `tests` | Referenced test commands must have been executed successfully. |

Paths are repository-relative globs supporting `*`, `**`, and `?`. Rename operations appear as old/new paths. Comparison includes committed changes since `base`, staged changes, unstaged changes and non-ignored untracked files. Default `base: HEAD` checks work not committed yet. For a committed PR, use its merge-base SHA or another explicit base:

```sh
jevtool verify --base <base-commit-sha> --run-tests --judge --json
```

All configured tests are required for an aggregate supported result. If a criterion lists tests that fail, that criterion fails regardless of model output. Tests are freshly executed; imported claims and old reports cannot count as test evidence. Working-tree changes during tests or judgment force aggregate review. Fingerprints identify the snapshot checked; a report does not apply after code changes.

For judgment criteria, no matching files, skipped sensitive/binary files, truncated excerpts or more than 12 matching files require review. Limits: 200 changed files, 2 MiB total Git command output, 6000 characters per excerpt and 96 KiB per model request. Narrow the task when these are exceeded.

Default semantic thresholds are `p >= 0.85` for support and `p <= 0.15` for failure; intermediate results require review. These are initial policy settings, **not project-calibrated accuracy guarantees**. A supported result describes evidence support, not proof that code is correct. Jev sees bounded text, not a running application.

| Exit code | Verify | Grep |
| --- | --- | --- |
| `0` | All checks supported | Matches found, no uncertain records |
| `1` | At least one failure | No matches, no uncertain records |
| `2` | Review required | At least one uncertain record |
| `3` | Operational/configuration error | Operational/configuration error |

Use advisory checks first when integrating with CI or an agent. Do not interpret exit 2 as success. Automatic Claude Code/Codex installation is not included in this preview.

## Filter records by meaning

Set `TYPESAFE_API_KEY` and run:

```sh
jevtool grep "Payment succeeded but membership was not activated" examples/payments.jsonl --format jsonl
cat events.jsonl | jevtool grep "Payment succeeded but membership was not activated" --format jsonl --json
```

Each nonempty line is a record. JSONL is parsed before any API request; text lines are passed as text. Original lines and line numbers are preserved in results. Unlike verify excerpts, **grep sends the supplied records to TypeSafe as provided**. Prefilter the input to the fields you want processed.

Requests use batches of up to 20 records. Default match threshold is 0.8; uncertain records are kept separately in `review`, not silently discarded. No partial result is emitted if a later batch fails. Maximum input is 1000 records, 2000 characters per record and 2 MiB total. CSV can be piped as text, but this preview does not parse multiline CSV or recurse through directories.

## Development and verification

```sh
npm test
npm run demo
npm pack --dry-run
```

Tests use isolated Git repositories and explicitly marked model fixtures. They exercise real subprocess exit codes, timeout handling, untracked/protected paths, snapshot invalidation, provider failures and uncertain filter results. They do not establish model accuracy on real deliveries. `eval` was also run end to end against the live API on jev-1.13.0 and jev-1.14.0 (2026-10-19).

Official API contract: [TypeSafe API reference](https://docs.typesafe.ai/api). Known model boundaries: [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## 中文快速说明

- `eval`：用带标准答案的测试集跑 Jev，给出准确率、错例、建议置信度阈值，以及换模型版本后哪些答案变了；需要 API key。
- `demo`：立即体验，在临时仓库里实际执行测试，展示三类未完成事项。
- `init`：在项目里创建验收清单，不覆盖已有文件。
- `verify`：检查 Git 改动；`--run-tests` 实际运行指定测试；`--judge` 才会发送相关证据给 Jev。
- `grep`：按自然语言条件筛选文本或 JSONL，输出原始记录和行号；需要 API key。
- 通过 `npm install -g jevtool` 安装。

MIT. Runs on Jev by TypeSafe. Not affiliated with TypeSafe AI.
