import { spawn, ChildProcess } from 'child_process'
import { basename, join, dirname, sep } from 'path'
import { tmpdir } from 'os'
import * as fs from 'fs'
import { getCacheDir } from 'yacr'
import * as minimatch from 'minimatch'
import {
  mkdir,
  symlinkDir,
  writeFile,
  remove,
  log,
  flatten,
  queue,
  stripAnsi,
  timeout,
  getFileContentHash,
  getStringHash,
  ensureDir,
  readFile,
  stat,
  readdir,
} from './utils'

const defaultLockfile = '.yall.lock'
const defaultYarnCacheDir = getCacheDir()
  .then(stripAnsi)
  .catch(() => '')

const cacheDirs: { [hash: string]: string } = {}

export interface YarnOptions {
  cacheFolder: string
  modulesFolder: string
}

export interface YallOptions extends YarnOptions {
  debug: boolean
  force: boolean
  forceChanged: boolean
  concurrency: number
  failFast?: boolean
  interval: number
  noExitOnError?: boolean
  npm?: boolean
  cwd: string
  dotFolders?: boolean
  in?: string[]
  folders?: string[]
  excludeFolders?: string[]
  includeFolders?: string[]
  here?: boolean
  linkFile?: boolean
  cleanUp?: boolean
  forceLocal?: boolean
  forceRemote?: boolean
  lock?: boolean | string
  lockEach?: boolean | string
  onlyWorkspaces?: boolean
  skipFirstRun: boolean
  separateCacheFolders?: string
}

const defaultOptions = {
  concurrency: 1,
}

type PackageDependencies = { [name: string]: string }

interface PackageManifest {
  name?: string
  version?: string
  workspaces?: string[]
  dependencies?: PackageDependencies
  devDependencies?: PackageDependencies
  yarn?: {
    args?: string[]
    flags?: string[]
  }
}

const findAllFolders = (folders: string[], options: YallOptions) => {
  const { npm, dotFolders, excludeFolders, includeFolders } = options
  const fileToLookup = npm ? 'package.json' : 'yarn.lock'
  const modulesFolder = options.modulesFolder || 'node_modules'
  const isExcluded = (folder: string) => {
    const name = basename(folder)
    return (
      name === modulesFolder ||
      (!dotFolders &&
        name[0] === '.' &&
        (includeFolders || []).indexOf(folder) < 0) ||
      (excludeFolders || []).indexOf(folder) >= 0
    )
  }

  const statErrorToDirectory = () => ({ isDirectory: () => true })
  const isFolderToScan = async (folder: string) =>
    (await stat(folder).catch(statErrorToDirectory)).isDirectory() &&
    !isExcluded(folder)
  const listFolder = async (folder: string): Promise<string[]> => {
    return basename(folder) === fileToLookup
      ? Promise.resolve([dirname(folder)])
      : folder === '.' || (await isFolderToScan(folder))
      ? Promise.all(
          (await readdir(folder).catch(() => [] as string[]))
            .map((file) => join(folder, file))
            .map((dir) => listFolder(dir))
        ).then(flatten)
      : Promise.resolve([])
  }
  const sortByPath = (paths: string[]) =>
    paths.sort((a, b) => {
      const byParts = a.split(sep).length - b.split(sep).length
      return byParts ? byParts : a.length - b.length
    })
  return Promise.all(folders.map(listFolder)).then(flatten).then(sortByPath)
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
      args = args.concat(pkg.yarn.flags.map((arg) => '--' + arg))
    }
    if (isArray(pkg.yarn.args)) {
      args = args.concat(pkg.yarn.args)
    }
  }
  return args
}

const readManifest = (folder: string) =>
  new Promise<PackageManifest>((resolve, reject) => {
    fs.readFile(join(folder, 'package.json'), 'utf-8', (err, data) => {
      err ? reject(err) : resolve(JSON.parse(data))
    })
  })

const getWorkspaces = async () => {
  const pkg = await readManifest('.')
  return pkg.workspaces || []
}

const getFileDeps = (deps: PackageDependencies = {}, excludeYalc: boolean) =>
  Object.keys(deps)
    .filter((name) => deps[name].match(/^file:.*/))
    .filter((name) => !excludeYalc || !deps[name].match(/^file:.*\.yalc\//))
    .map((name) => ({
      name,
      address: deps[name],
      path: deps[name].replace(/^file:/, ''),
    }))

const getLocalDeps = (deps: PackageDependencies = {}) =>
  Object.keys(deps)
    .filter((name) => deps[name].match(/^(file|link):.*/))
    .map((name) => ({
      name,
      address: deps[name],
      path: deps[name].replace(/^(file|link):/, ''),
    }))

const remoteDepsRegPattern = /^(github|bitbucket|git+ssh|git|http|https):/
const getRemoteDeps = (deps: PackageDependencies = {}) =>
  Object.keys(deps)
    .filter((name) => deps[name].match(remoteDepsRegPattern))
    .map((name) => ({
      name,
      address: deps[name],
    }))

const getPackageFileDeps = (pkg: PackageManifest, excludeYalc: boolean) =>
  getFileDeps(pkg.dependencies, excludeYalc).concat(
    getFileDeps(pkg.devDependencies, excludeYalc)
  )

const getPackageLocalDeps = (pkg: PackageManifest) =>
  getLocalDeps(pkg.dependencies).concat(getLocalDeps(pkg.devDependencies))

const getPackageRemoteDeps = (pkg: PackageManifest) =>
  getRemoteDeps(pkg.dependencies).concat(getRemoteDeps(pkg.devDependencies))

const linkFileDeps = async (
  pkg: PackageManifest,
  cwd: string,
  modulesFolder = 'node_modules'
) => {
  const fileDeps = getPackageFileDeps(pkg, true)
  if (!fileDeps.length) {
    return Promise.resolve()
  }

  await mkdir(join(cwd, modulesFolder))
  return Promise.all(
    fileDeps.map(async (dep) => {
      const src = join(cwd, dep.path)
      const dest = join(cwd, modulesFolder, dep.name)
      log.just(
        `Linking file dependency in ${cwd}: ` +
          `${dep.path} ==> ${join(modulesFolder, dep.name)}`
      )
      await remove(dest)
      return symlinkDir(src, dest)
    })
  )
}

type RunResult = {
  folder: string
  code?: number
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
        PATH: process.env.PATH,
      },
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

const parseCacheDirFromError = (
  error: string,
  cacheFolder: string
): string | undefined => {
  const match =
    error.match(
      RegExp(`${cacheFolder}${sep}([^${sep} "]*)`.replace(/\\/g, '\\\\'))
    ) || error.match(/error Bad hash\. ()/)

  if (match) {
    return match[1] ? join(cacheFolder, match[1]) : match[1]
  }
  return undefined
}

const watchLock: { [folder: string]: number } = {}

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
      const addArgs = []
      if (!command) {
        if (options.forceLocal) {
          const localDeps = getPackageLocalDeps(pkg)
          if (localDeps.length) {
            command = 'add'
            addArgs.push(localDeps.map((_) => _.address).join(' '))
          }
        }
        if (options.forceRemote) {
          const remoteDeps = getPackageRemoteDeps(pkg)
          if (remoteDeps.length) {
            command = 'add'
            addArgs.push(remoteDeps.map((_) => _.address).join(' '))
          }
        }
      }
      const args = ([command] || [])
        .concat(addArgs)
        .concat(getAdditionalRunArgs(options, pkg))

      const file = options.npm ? 'npm' : 'yarn'

      const where =
        `${folder || '.'}` + pkg.name && pkg.version
          ? ` (${pkg.name}@${pkg.version})`
          : ''

      if (options.cleanUp) {
        const modulesFolder = options.modulesFolder || 'node_modules'
        if (options.debug) {
          log.just(`Removing ${modulesFolder} in ${where}`)
        }
        await remove(join(cwd, modulesFolder))
      }

      let cacheFolder = options.cacheFolder

      const sepCache = options.separateCacheFolders
      if (typeof sepCache === 'string') {
        if (!options.cacheFolder) {
          cacheFolder = (await defaultYarnCacheDir).replace(/v\d+$/, '')
        }
        cacheFolder = join(
          cacheFolder,
          getStringHash(
            [options.separateCacheFolders, folder].join('/').replace(/\\/g, '/')
          )
        )
      }

      const cacheDir =
        cacheDirs[cacheFolder] || (await getCacheDir({ cacheFolder }))
      cacheDirs[cacheFolder] = cacheDir

      if (sepCache || options.cacheFolder) {
        await ensureDir(cacheFolder)
        args.push(`--cache-folder ${cacheFolder}`)
      }

      if (options.force) {
        args.push('--force')
      }

      const cmd = [file].concat(args).join(' ')
      log.start(`Running \`${cmd}\` in ${where}`)

      const startTime = new Date().getTime()
      const folderToRun = folder
      spawnRun(folder, file, args).then(async (result) => {
        watchLock[folderToRun] = new Date().getTime()
        const { code, error, folder } = result
        if (options.linkFile) {
          await linkFileDeps(pkg, join(cwd, folder), options.modulesFolder)
        }
        const timeTakenSec = (new Date().getTime() - startTime) / 1000
        const timeTaken = `(${timeTakenSec.toFixed(1)} sec)`
        if (result.code) {
          const codeStr = code ? `with code ${code}` : ``
          log[code ? 'error' : 'finish'](
            `Finished running in ${where} ${codeStr}`
          )
          options.failFast && failFastExit(1)
        } else if (error) {
          options.failFast && failFastExit(1)
          log.error(`Failed running in ${folder}: ${error} ${timeTaken}`)
        } else {
          log.finish(`Finished running in ${folder} ${timeTaken}`)
        }
        resolve(result)
      })
    })
  }
}

let firstRun = true

const getFoldersToRun = async (options: YallOptions) => {
  let folders = ([] as string[]).concat(options.folders || '.')
  if (options.onlyWorkspaces) {
    firstRun = false
    if (firstRun) {
      return ['.']
    } else {
      const allFolders = await findAllFolders(folders, options)
      const workspaces = await getWorkspaces()
      const filtered = allFolders.slice(1).filter((folder) =>
        workspaces.reduce((res, ws) => {
          return res || minimatch(folder, ws)
        }, false)
      )
      return ['.'].concat(filtered)
    }
  }
  if (!options.here) {
    folders = await findAllFolders(folders, options)
  }
  return folders
}

const getLockFileName = (options: YallOptions) => {
  return typeof options.lock === 'string' ? options.lock || defaultLockfile : ''
}

const writeLockFile = async (options: YallOptions) => {
  const cwd = options.cwd
  const runLockfile = getLockFileName(options)
  if (runLockfile) {
    await writeFile(join(cwd, runLockfile))
  }
}

const removeLockFile = async (options: YallOptions) => {
  const runLockfile = getLockFileName(options)
  if (runLockfile) {
    log.just(`Removing lock file: ${runLockfile}`)
    try {
      await remove(runLockfile)
    } catch (e) {
      log.error(`Error removing lock file`, e)
    }
  }
}

export const runAll = async (command: string, options: YallOptions) => {
  options = Object.assign({}, defaultOptions, options)

  await writeLockFile(options)

  const folders = await getFoldersToRun(options)
  const startTime = new Date().getTime()
  return queue(folders, runOne(command, options), options.concurrency)
    .then(async (results) => {
      const fails: RunResult[] = []
      const isFailed = (r: RunResult) => r.error || r.code
      for (let r of results) {
        const cacheErrorDir = r.error
          ? parseCacheDirFromError(r.error!, options.cacheFolder)
          : undefined
        if (cacheErrorDir) {
          log.warn(`Removing error cache dir ${cacheErrorDir}`)
          try {
            await remove(cacheErrorDir)
          } catch (e) {
            log.error(`Error happened while removing ${cacheErrorDir}`, e)
          }
        }
        if (isFailed(r)) {
          log.warn(
            `Try to run again sequentially in \`${r.folder}\` because of error: ${r.error}`
          )
          r = await runOne(command, options)(r.folder)
        }
        isFailed(r) && fails.push(r)
      }
      const timeTakenSec = (new Date().getTime() - startTime) / 1000
      const timeTaken = `(${timeTakenSec.toFixed(1)} sec)`
      if (fails.length) {
        fails.forEach((result) => {
          const { error, code, folder } = result!
          if (code) {
            log.error(
              `Process in \`${folder}\` exited with error code: ${code}: ${error}`
            )
          } else if (error) {
            log.error(`Process in \`${folder}\` failed: ${error}`)
          }
        })
        log.error(
          `Yall done with ${fails.length} errors in ${folders.length} folders ${timeTaken}!`
        )
        if (!options.noExitOnError) {
          process.exit(1)
        }
      } else {
        log.finish(`Yall done fine in ${folders.length} folders ${timeTaken}!`)
      }
      if (options.debug) {
        log.just(`Folders processed: ${folders}`)
      }
      return results
    })
    .then(async (results) => {
      await removeLockFile(options)
      return results
    })
}

const getWatchedFileCachedHashPath = (filePath: string) =>
  join(tmpdir(), `yall_cached_hash_${getStringHash(filePath)}`)

export const watchAll = async (
  command: string,
  options: YallOptions,
  watchFiles: string[] | undefined,
  watchContentFiles: string[] | undefined
) => {
  options = Object.assign({}, defaultOptions, options)
  const cwd = options.cwd
  let filesToWatch: { file: string; content: boolean }[] = []
  filesToWatch = (watchFiles || [])
    .map((file) => ({ file, content: false }))
    .concat((watchContentFiles || []).map((file) => ({ file, content: true })))
  if (!filesToWatch.length) {
    filesToWatch = options.npm
      ? [
          {
            file: 'package.json',
            content: !!watchContentFiles,
          },
        ]
      : [
          {
            file: 'yarn.lock',
            content: !!watchContentFiles,
          },
        ]
  }

  const changedFolders: string[] = []
  const watchedFilesHashes: { [name: string]: string } = {}
  const watchedFiles: { [name: string]: true } = {}
  const addToChanged = (folder: string) =>
    changedFolders.indexOf(folder) ? changedFolders.push(folder) : ''
  const outputWatchMessage = () =>
    log.warn(
      'Watching for changes:',
      filesToWatch
        .map(({ file, content }) => `${file}` + (content ? ` (content)` : ''))
        .join(', ')
    )
  const putHandlers = async () => {
    const folders = await getFoldersToRun(options)
    return Promise.all(
      folders.map((folder) => {
        return Promise.all(
          filesToWatch
            .map(({ file, content }) => ({ content, file: join(folder, file) }))
            .filter(({ file }) => !watchedFiles[file])
            .map(async ({ file, content }) => {
              const hash = await getFileContentHash(file)
              if (!hash) {
                return
              }
              const cachedHash = await readFile(
                getWatchedFileCachedHashPath(join(cwd, file))
              ).catch(() => '')
              if (cachedHash !== hash) {
                addToChanged(folder)
              } else {
                log.just(
                  `Cached hash of ${file} in ${folder} didn't change from last run.`
                )
              }

              watchedFilesHashes[file] = hash
              watchedFiles[file] = true
              fs.watchFile(
                file,
                { persistent: true, interval: options.interval || 1000 },
                async () => {
                  const eventTime = new Date().getTime()
                  const hash = await getFileContentHash(file)
                  if (!hash) {
                    log.warn(
                      `Could not get hash of file ${file}, removing from watch.`
                    )
                    delete watchedFilesHashes[file]
                    delete watchedFiles[file]
                    fs.unwatchFile(file, () => {})
                    return
                  }
                  if (watchLock[folder]) {
                    const changedHappenedJustAfterRun =
                      Math.abs(watchLock[folder] - eventTime) < 1000
                    if (changedHappenedJustAfterRun) {
                      log.warn(
                        `Change of ${file} in ${folder} happened just after run, skipping it.`
                      )
                      watchedFilesHashes[file] = hash
                    }
                    delete watchLock[folder]
                  }
                  if (content && hash === watchedFilesHashes[file]) {
                    return
                  }
                  watchedFilesHashes[file] = hash
                  log.warn(`File changed: ${file} in ${folder}`)
                  addToChanged(folder)
                }
              )
            })
        )
      })
    )
  }

  await putHandlers()
  outputWatchMessage()
  const checkChanged = async () => {
    let p: Promise<any> = timeout(2500)

    p = !changedFolders.length
      ? timeout(2500)
      : runAll(
          command,
          Object.assign({}, options, {
            force: options.force || options.forceChanged,
            noExitOnError: true,
            excludeFolders: [],
            includeFolders: [],
            here: true,
            folders: changedFolders.concat([]),
          })
        )
          .then(async (results) => {
            changedFolders.splice(0, changedFolders.length)

            results
              .filter((result) => result.code === 0)
              .map((result) => {
                const files = filesToWatch.map((f) =>
                  join(result.folder, f.file)
                )
                return Promise.all(
                  files.map((file) =>
                    writeFile(
                      getWatchedFileCachedHashPath(join(cwd, file)),
                      watchedFilesHashes[file]
                    )
                  )
                )
              })
          })
          .then(outputWatchMessage)

    p.then(putHandlers).then(checkChanged)
  }
  if (!changedFolders.length) {
    await removeLockFile(options)
  }
  return checkChanged()
}
