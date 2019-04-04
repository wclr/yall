#!/usr/bin/env node
import * as yargs from 'yargs'
import { YallOptions, runAll, watchAll } from '.'

const yallFlags = [
  'debug',
  'concurrency',
  'con',
  'clean-up',
  'fail-fast',
  'npm',
  'in',
  'folders',
  'exclude-folders',
  'include-folders',
  'here',
  'link-file',
  'link-files',
  'watch',
  'watch-content',
  'force',
  'force-local',
  'force-remote',
  'cwd',
  'dot-folders',
  'lock',
  'lock-each',
  'cache-folder',
  'only-workspaces',
  'separate-cache-folders',
  'skip-first-run',
  'sep-cache'
]

const cliCommand = 'yall'

interface Args extends YallOptions {
  watch?: string[]
  watchContent?: string[]
  _: string[]
}

const removeDoubleHypenFromArgv = () => {
  const rev = process.argv.concat([]).reverse()
  rev.forEach(
    (arg, i) => arg === '--' && process.argv.splice(rev.length - i - 1, 1)
  )
  return process.argv.slice(2)
}

yargs
  .usage(cliCommand + '[yarn|npm command] [yarn|npm flags] [yall flags]')
  .string(['cache-folder', 'modules-folder'])
  .option('concurrency', {
    alias: 'con',
    type: 'number',
    describe: 'Number of concurrenlty running commands',
    default: 10
  })
  .option('interval', {
    type: 'number',
    describe: 'Watch pooling interval, in ms',
    default: 1000
  })
  .options('link-file', {
    alias: 'link-files',
    describe: 'Create symlinks for `file:` dependencies',
    type: 'boolean'
  })
  .options('separate-cache-folders', {
    alias: 'sep-cache',
    describe: 'Seed to make a separate cache folder for each installation.',
    type: 'string'
  })
  .string(['lock', 'lock-each'])
  .array([
    'folders',
    'exclude-folders',
    'include-folders',
    'in',
    'watch',
    'watch-content'
  ])
  .boolean([
    'force',
    'debug',
    'here',
    'fail-fast',
    'npm',
    'dot-folders',
    'only-workspaces'
  ])
  .help(true).argv as Args

const argv = yargs.parse(removeDoubleHypenFromArgv()) as Args

process.stdin.setMaxListeners(0)
process.stdout.setMaxListeners(0)
process.setMaxListeners(0)

const isFlag = (arg: string) => arg.match(/^--?\w/)
const isYallFlag = (arg: string) =>
  yallFlags.indexOf(arg.replace(/^--?/, '')) >= 0

const parseRunArguments = () => {
  const runArgs: string[] = []
  let takeArg = false
  process.argv.forEach((arg, i) => {
    if (isFlag(arg)) {
      takeArg = !isYallFlag(arg)
    }
    takeArg && runArgs.push(arg)
  })
  return runArgs
}

const command = argv._.concat(parseRunArguments()).join(' ')
const options = argv

if (options.in) {
  options.folders = options.in
  options.here = true
}

options.cwd = options.cwd || process.cwd()

const version = require('./package.json').version
console.log(`yall v${version}`)

if (argv.onlyWorkspaces) {
  console.log('Running only for Yarn workspaces.')
}

if (argv.watch || argv.watchContent) {
  watchAll(command, argv, argv.watch, argv.watchContent)
} else {
  runAll(command, argv)
}
