# create-deepseek-harness-action

Create safe starter workflows for
[DeepSeek Harness Action](https://github.com/Lixiaoyiao/deepseek-harness-action).

```bash
npm create deepseek-harness-action@latest
```

The interactive installer offers **PR Review**, **@dsh Coding Commands**, or
**Both**. For non-interactive use, select the mode explicitly:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

Valid modes are `review`, `commands`, and `both`. The installer creates only
workflow files. It does not add secrets, commit, push, or open a pull request.
Existing workflow files are never overwritten.
