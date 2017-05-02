import * as glob from 'glob'
import { exec, execFile, spawn, ChildProcess } from 'child_process'
import { join, dirname, normalize, sep } from 'path'
import * as fs from 'fs'
import {
  getCacheFolder,
  removeFromCache
} from 'yacr'
import {
  mkdir, symlinkDir, writeFile, remove,
  log, flatten, queue
} from './utils'

export interface YarnOptions {
  cacheFolder: string,
  modulesFolder: string
}

export interface YallOptions extends YarnOptions {
  concurrency: number
  failFast: boolean
  npm: boolean,
  folders: string[]
  excludeFolders: string[],
  here: string,
  linkFile: boolean
  watch?: boolean | string[],
  runLock: boolean | string
  runLockAll: boolean | string
}

const defaultOptions = {
  concurrency: 10
}

interface PackageManifest {
  name: string,
  version: string,
  dependencies?: { [name: string]: string },
  devDependencies?: { [name: string]: string }
  yarn?: {
    args?: string[]
    flags?: string[]
  }
}

const findAllFolders = (folders: string[], npm: boolean, modulesFolder: string) => {
  const fileToLookup = npm ? 'package.json' : 'yarn.lock'
  return Promise.all(folders.map(folder =>
    new Promise<string[]>((resolve, reject) => {
      glob('**/' + fileToLookup, {
        ignore: ['**/node_modules/**'].concat(
          modulesFolder ? `'**/${modulesFolder}/**'` : []
        )
      }, (err, paths) => {
        err ? reject(err) : resolve(paths.map(dirname))
      })
    })
  )).then(flatten)
}

const pipeChildProcess = (cp: ChildProcess) => {
  cp.stdout.pipe(process.stdout)
  cp.stderr.pipe(process.stderr)
}

const isArray = Array.isArray

const getAdditionalRunArgs = (options: YallOptions, pkg: PackageManifest) => {
  let args: string[] = []
  if (!options.npm && pkg.yarn) {
    if (isArray(pkg.yarn.flags)) {
      args = args.concat(pkg.yarn.flags.map(arg => '--' + arg))
    }
    if (isArray(pkg.yarn.args)) {
      args = args.concat(pkg.yarn.args)
    }
  }
  return args
}

const readManifest = (folder: string) =>
  new Promise<PackageManifest>((resolve, reject) => {
    fs.readFile(join(folder, 'package.json'), 'utf-8',
      (err, data) => {
        err ? reject(err) : resolve(JSON.parse(data))
      })
  })

const getFileDeps = (deps: any, excludeYalc: boolean) =>
  Object.keys(deps || [])
    .filter(name => deps[name].match(/^file:.*/))
    .filter(name => !excludeYalc ||
      !deps[name].match(/^file:.*\.yalc\//))
    .map(name => ({
      name, address: deps[name].replace(/^file:/, '')
    }))

const getPackageFileDeps = (pkg: PackageManifest, excludeYalc: boolean) =>
  getFileDeps(pkg.dependencies, excludeYalc)
    .concat(getFileDeps(pkg.devDependencies, excludeYalc))

const removeFileDepsFromCache = (pkg: PackageManifest,
  cacheFolder: string) => {
  const fileDeps = getPackageFileDeps(pkg, false).map(dep => dep.name)
  return removeFromCache(fileDeps, { cacheFolder })
}

const linkFileDeps = async (pkg: PackageManifest,
  cwd: string, modulesFolder = 'node_modules') => {
  const fileDeps = getPackageFileDeps(pkg, true)
  if (!fileDeps.length) {
    return Promise.resolve()
  }

  await mkdir(join(cwd, modulesFolder))
  return Promise.all(fileDeps.map(
    async (dep) => {
      const src = join(cwd, dep.address)
      const dest = join(cwd, modulesFolder, dep.name)
      log.just(`Linking file dependency in ${cwd}: ` +
        `${dep.address} ==> ${join(modulesFolder, dep.name)}`)
      await remove(dest)
      return symlinkDir(src, dest)
    }
  ))
}

type RunResult = {
  folder: string,
  code?: number,
  error?: string
} | undefined

const failFastExit = (code: number) => {
  if (code) {
    log.error('Fail fast. Exiting.')
    process.exit(code)
  }
}

export const runOne = (command: string, options: YallOptions) => {
  return (folder: string) => {
    return new Promise<RunResult>(async (resolve) => {
      let pkg: PackageManifest
      try {
        pkg = await readManifest(folder)
      } catch (error) {
        resolve({ error, folder })
        return
      }
      const args = ([command] || [])
        .concat(getAdditionalRunArgs(options, pkg))

      const file = options.npm ? 'npm' : 'yarn'
      const cmd = [file]
        .concat(args).join(' ')
      const where = `${folder} (${pkg.name}@${pkg.version})`
      log.yarnStart(`Running \`${cmd}\` in ${where}`)

      // this is to workaround yarn's back with file: deps      
      if (options.cacheFolder) {
        await removeFileDepsFromCache(pkg, options.cacheFolder)
      }
      if (options.linkFile) {
        await linkFileDeps(pkg,
          join(process.cwd(), folder),
          options.modulesFolder
        )
      }

      const child = spawn(file, args, {
        cwd: folder,
        shell: true,
        env: {
          FORCE_COLOR: true,
          PATH: process.env.PATH
        }
      })
      pipeChildProcess(child)
      child.on('error', (error) => {
        log.error(`Faild running in ${folder}: {err.message}`)
        if (options.failFast) {
          failFastExit(1)
        } else {
          resolve({ folder, error: error.message })
        }
      })
      child.on('exit', (code) => {
        const codeStr = (code ? `with code ${code}` : ``)
        log[code ? 'error' : 'yarnFinish']
          (`Finished running in ${where}${codeStr}`)
        if (code && options.failFast) {
          failFastExit(code)
        }
        resolve(code ? { folder, code } : undefined)
      })
    })
  }
}

const getFoldersToRun = async (options: YallOptions) => {
  let folders = options.folders || ['.']
  if (!options.here) {
    folders = await findAllFolders(
      folders, options.npm, options.modulesFolder)
  }
  if (options.excludeFolders) {
    const exFolders = options
      .excludeFolders.map(f => f + sep)
      .map(normalize)
    folders = folders.filter(folder =>
      !exFolders.reduce((doExclude, exFolder) =>
        doExclude || (folder + sep).indexOf(exFolder) >= 0,
        false)
    )
  }
  return Promise.resolve(folders)
}

export const runAll = async (command: string, options: YallOptions) => {
  options = Object.assign({}, defaultOptions, options)
  if (!options.npm && !options.cacheFolder) {
    options.cacheFolder = await getCacheFolder()
  }
  if (options.watch) {

  }
  const folders = await getFoldersToRun(options)
  return queue(folders, runOne(command, options),
    options.concurrency).then((results) => {
      const fails = results.filter(_ => _)
      if (fails.length) {
        fails.forEach((result) => {
          const { error, code, folder } = result!
          if (code) {
            log.error(`Process in ${folder} exited with error code: ${code}`)
          }
          if (error) {
            log.error(`Process in ${folder} failed: ${error}`)
          }
        })
        log.error('Yall done with errors!')
      } else {
        log.finish('Yall done fine!')
      }
    })
}

const watchAll = async (command: string, options: YallOptions) => {
  options = Object.assign({}, defaultOptions, options)
  if (!options.npm && !options.cacheFolder) {
    options.cacheFolder = await getCacheFolder()
  }
  const folders = await getFoldersToRun(options)
  //fs.watchFile()
}
