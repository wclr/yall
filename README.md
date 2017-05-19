# Yall

> Yarn workflow for monorepos (projects with multiple packages). And not only.

## Why

Because.

## What

- `Yall` is like `yarn/npm` for multiple folders with `package.json`/`yarn.lock`. 
- It looks up for folders with `package.json/yarn.lock` in the project tree and runs there given command (by default in parallel).
- It can watch manifest/lock files and run commands automatically on change, this is useful in container based scenarios.
- Can handle [cache error which may occurr when running `yarn` commands concurrently](https://github.com/yarnpkg/yarn/issues/683).

## Install

![npm (scoped)](https://img.shields.io/npm/v/@whitecolor/yall.svg?maxAge=86400) [![Build Status](https://travis-ci.org/whitecolor/yall.svg?branch=master)](https://travis-ci.org/whitecolor/yall)

```
  npm i @whitecolor/yall -g
```

*Work in progress. It is a pre-release.*

## Usage 

```
yall [yarn|npm command] [yarn|npm flags] [yall flags]
```

Additional `yall's` option flags:

- `concurrency` (`con`) - max count of tasks to run in parallel
- `fail-fast` - interupt process as soon as when the first error occures (by default process is not interupted if error happend in one of the folders, but when all tasks finished it exits with error code)
- `folders` - folders where to run (including nested), relative to cwd, wilcard not supported
- `dot-folders` - include (hidden) folders starting with dot
- `exclude-folders` - folders where not to run (including nested)
- `include-folders` - additional folders to include (for example: explit dot folders).
- `here` - will run only in current folder, if `folders` specified will run in those folders, but without nested
- `in` - shortcut for  `--include-folders` plus `--here`
- `link-files` - create symlinks for `file:` dependencies (will not touch [`yalc`](http://github.com/whitecolor/yalc) dependencies)
- `npm` - run `npm` command, alternativly to `yarn`
- `clean-up` - will clean-up/remove `node_modules` before command run
- `lock` - will create `.yall.lock` file (or file with specified name) while running commands and remove it after everything is done.
- `watch` - watch mode, will watch for changes of `yarn.lock` (`package.json` in case of `npm` or custom list of files specified) and run command in folder where file changed, it periodically rescans folders for new files
- `watch-content` - will check file content for change, not just all change events.

## Licence

WTF.