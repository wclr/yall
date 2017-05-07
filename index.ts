import * as glob from 'glob'
import { exec, execFile, spawn, ChildProcess } from 'child_process'
import { join, resolve, dirname, normalize, sep } from 'path'
import * as fs from 'fs'
import {
  getCacheFolder,
  removeFromCache
} from 'yacr'
import {
  mkdir, symlinkDir, writeFile, remove,
  log, flatten, queue, stripAnsi,
  timeout
} from './utils'

const defaultRunLockfile = '.yall.lock'

export interface YarnOptions {
  cacheFolder: string,
  modulesFolder: string
}

export interface YallOptions extends YarnOptions {
  concurrency?: number
  failFast?: boolean
  npm?: boolean,
  cwd?: string,
  dotFolders?: boolean,
  folders?: string[],
  excludeFolders?: string[],
  includeFolders?: string[],
  here?: string,
  linkFile?: boolean
  cleanUp?: boolean,
  lock?: boolean | string
  lockEach?: boolean | string
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

const findAllFolders = (folders: string[],
  npm: boolean, modulesFolder: string, dotFolders: boolean) => {
  const fileToLookup = npm ? 'package.json' : 'yarn.lock'
  return Promise.all(folders.map(folder =>
    new Promise<string[]>((resolve, reject) => {
      glob('**/' + fileToLookup, {
        cwd: folder,
        dot: dotFolders,
        ignore: ['**/node_modules/**'].concat(
          modulesFolder ? `'**/${modulesFolder}/**'` : []
        )
      }, (err, paths) => {
        err ? reject(err) : resolve(paths.map(dirname)
          .map(p => join(folder, p)))
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
}

const failFastExit = (code: number) => {
  if (code) {
    log.error('Fail fast. Exiting.')
    process.exit(code)
  }
}

const spawnRun = (folder: string, file: string, args: string[]) => {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: folder,
      shell: true,
      env: {
        FORCE_COLOR: true,
        PATH: process.env.PATH
      }
    })

    pipeChildProcess(child)

    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('error', (error) => {
      resolve({ folder, error: stripAnsi(error.message) })
    })

    child.on('exit', (code) => {
      resolve({ folder, error: code ? stripAnsi(stderr) : '', code: code })
    })
  })
}

const parseCacheError = (error: string, cacheFolder: string): string | undefined => {
  const match = error
    .match(RegExp(
      `${cacheFolder}${sep}([^${sep}]*)`.replace(/\\/g, '\\\\')
    )) || error.match(/error Bad hash\. ()/)

  if (match) {
    console.log('parseCacheError', error)
    return match[1]
  }
  return undefined
}

export const runOne = (command: string, options: YallOptions) => {
  return (folder: string) => {
    return new Promise<RunResult>(async (resolve) => {
      let pkg: PackageManifest
      try {
        pkg = await readManifest(folder)
      } catch (error) {
        resolve({ error: error.message, folder })
        return
      }
      const cwd = process.cwd()
      const args = ([command] || [])
        .concat(getAdditionalRunArgs(options, pkg))

      const file = options.npm ? 'npm' : 'yarn'
      const cmd = [file]
        .concat(args).join(' ')
      const where = `${folder} (${pkg.name}@${pkg.version})`
      log.start(`Running \`${cmd}\` in ${where}`)

      if (options.cleanUp) {
        const modulesFolder = options.modulesFolder || 'node_modules'
        log.warn(`Removing ${modulesFolder} in ${where}`)
        await remove(join(cwd, modulesFolder))
      }
      // this is to workaround yarn's back with `file:` deps      
      if (options.cacheFolder) {        
        await removeFileDepsFromCache(pkg, options.cacheFolder)
      }
      if (options.linkFile) {
        await linkFileDeps(pkg,
          join(cwd, folder),
          options.modulesFolder
        )
      }

      spawnRun(folder, file, args).then((result) => {
        const { code, error, folder } = result
        if (result.code) {
          const codeStr = (code ? `with code ${code}` : ``)
          log[code ? 'error' : 'finish']
            (`Finished running in ${where} ${codeStr}`)
          options.failFast && failFastExit(1)
        } else if (error) {
          options.failFast && failFastExit(1)
          log.error(`Failed running in ${folder}: ${error}`)
        } else {
          log.finish(`Finished running in ${folder}`)
        }
        resolve(result)
      })

    })
  }
}

const getFoldersToRun = async (options: YallOptions) => {
  let folders = (options.folders || ['.'])
    .concat(options.includeFolders || [])

  if (!options.here) {
    folders = await findAllFolders(
      folders, !!options.npm, options.modulesFolder, !!options.dotFolders)
  }

  if (options.excludeFolders) {
    const exFolders = options
      .excludeFolders.map(f => f + sep)
      .map(normalize)
    folders = folders
      .filter(folder =>
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
  const cwd = options.cwd || process.cwd()
  const runLockfile = typeof options.lock === 'string' ?
    (options.lock || defaultRunLockfile) : ''
  if (runLockfile) {
    await writeFile(join(cwd, runLockfile))
  }
  const folders = await getFoldersToRun(options)

  return queue(folders, runOne(command, options),
    options.concurrency!).then(async (results) => {
      const fails: RunResult[] = []
      const isFailed = (r: RunResult) => r.error || r.code

      for (let r of results) {
        const cacheErrorDir = r.error ?
          parseCacheError(r.error!, options.cacheFolder) : undefined
        if (typeof cacheErrorDir === 'string') {
          log.warn(`Try to run again in ${r.folder} because of cache error: ${r.error}`)
          if (cacheErrorDir) {
            try {
              await remove(cacheErrorDir)
            } catch (e) { }
          }
          r = await runOne(command, options)(r.folder)
        }
        isFailed(r) && fails.push(r)
      }

      if (fails.length) {
        fails.forEach((result) => {
          const { error, code, folder } = result!
          if (code) {
            log.error(`Process in ${folder} exited with error code: ${code}!`)
          }
          if (error) {
            log.error(`Process in ${folder} failed: ${error}`)
          }
        })
        log.error('Yall done with errors!')
      } else {
        log.finish('Yall done fine!')
      }
    }).then(async (result) => {
      if (runLockfile) {
        await remove(runLockfile)
        return result
      }
    })
}

export const watchAll = async (command: string, options: YallOptions, watchFiles: string[] = []) => {
  options = Object.assign({}, defaultOptions, options)
  if (!options.npm && !options.cacheFolder) {
    options.cacheFolder = await getCacheFolder()
  }
  const cwd = options.cwd || process.cwd()

  if (!watchFiles.length) {
    watchFiles = options.npm ? ['package.json'] : ['yarn.lock']
  }
  log.warn('Watching for changes:', watchFiles.join(', '))
  const changedFolders: string[] = []
  const watchedFiles: string[] = []

  const putHandlers = async () => {
    const folders = await getFoldersToRun(options)
    folders.forEach(folder => {
      watchFiles
        .map(file => join(folder, file))
        .filter(file => watchedFiles.indexOf(file) < 0)
        .forEach((file) => {
          watchedFiles.push(file)
          fs.watchFile(file, { persistent: true }, (curr) => {
            log.warn('Watched file change:', file)
            if (changedFolders.indexOf(folder) < 0) {
              changedFolders.push(folder)
            }
          })
        })
    })
    return folders
  }
  await putHandlers().then(folders => changedFolders.splice(0, 0, ...folders))
  const checkChanged = async () => {
    let p: Promise<any> = timeout(2500)
    if (changedFolders.length) {
      p = runAll(command, Object.assign({}, options, {
        here: true,
        folders: changedFolders.concat([])
      }))
      changedFolders.splice(0, changedFolders.length)
    }
    p.then(putHandlers)
      .then(checkChanged)
  }
  return checkChanged()
}
