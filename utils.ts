import fs from 'fs'
import { promises as fsP } from 'fs'
import rimraf from 'rimraf'
import chalk from 'chalk'
import crypto from 'crypto'

export const colors = {
  start: chalk.magenta,
  finish: chalk.magenta,
  warn: chalk.yellow,
  just: chalk.gray,
  error: chalk.red,
}

type ColorLog = {
  [key in keyof typeof colors]: (
    colorMessage: string,
    ...items: string[]
  ) => void
}
export const log: ColorLog = Object.keys(colors).reduce<ColorLog>(
  (obj, key: keyof typeof colors) =>
    Object.assign(obj, {
      [key]: (colorMessage: string, ...items: string[]) =>
        console.log(colors[key](colorMessage), ...items),
    }),
  {} as any
)

export const stripAnsi = (str: string) =>
  str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  )

export const flatten = <T>(lists: T[][]): T[] =>
  lists.reduce<T[]>((flat, list) => flat.concat(list), [])

export const mkdir = (dir: string) =>
  new Promise((resolve, reject) => {
    fs.access(dir, (err) => {
      err
        ? fs.mkdir(dir, (err) => {
            err ? reject(err) : resolve()
          })
        : resolve()
    })
  })

export const remove = (path: string) =>
  new Promise((resolve, reject) => {
    rimraf(path, (err) => (err ? reject(err) : resolve()))
  })

export const symlinkDir = (srcpath: string, dstpath: string) =>
  new Promise((resolve, reject) => {
    fs.symlink(srcpath, dstpath, 'dir', (err) =>
      err ? reject(err) : resolve()
    )
  })

export const timeout = (ms: number) =>
  new Promise((resolve, reject) => {
    setTimeout(() => resolve(), ms)
  })

export const readFile = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    fs.readFile(filePath, 'utf-8', (err, data) =>
      err ? reject(err) : resolve(data)
    )
  })

export const readdir = (dirpath: string) =>
  new Promise<string[]>((resolve, reject) => {
    fs.readdir(dirpath, (err, data) => (err ? reject(err) : resolve(data)))
  })

export const stat = (filepath: string) =>
  new Promise<fs.Stats>((resolve, reject) => {
    fs.stat(filepath, (err, data) => (err ? reject(err) : resolve(data)))
  })

export const writeFile = (filePath: string, data = '') =>
  new Promise((resolve, reject) => {
    fs.writeFile(filePath, data, (err) => (err ? reject(err) : resolve()))
  })

export const ensureDir = (dirPath: string) =>
  new Promise((resolve, reject) => {
    fs.access(dirPath, (err) => {
      err
        ? fs.mkdir(dirPath, (err) => (err ? reject(err) : resolve()))
        : resolve(dirPath)
    })
  })

export function queue<T, U>(
  items: U[],
  promiseProducer: (result: U) => Promise<T>,
  concurrency: number
): Promise<Array<T>> {
  concurrency = Math.min(concurrency, items.length)
  const results: T[] = []
  const total = items.length
  items = items.slice()
  return new Promise((resolve, reject) => {
    const next = () => {
      promiseProducer(items.shift()!).then(function (result) {
        results.push(result)
        if (results.length === total) {
          resolve(results)
        } else if (items.length) {
          next()
        }
      }, reject)
    }
    Array.from(Array(concurrency).keys()).forEach(next)
  })
}

export const getStringHash = (str: string) =>
  crypto.createHash('md5').update(str).digest('hex')

export const getFileContentHash = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    const md5sum = crypto.createHash('md5')
    stream.on('data', (data: string) => md5sum.update(data))
    stream.on('error', () => resolve(''))
    stream.on('end', () => resolve(md5sum.digest('hex')))
  })

export const getJsonFiledContentHash = async (
  filePath: string,
  field: string
) => {
  const fileContent = await fsP.readFile(filePath, 'utf-8')
  try {
    const json = JSON.parse(fileContent)
    if (json[field] === 'undefined') {
      return null
    }
    const data = JSON.stringify(json[field])
    return crypto.createHash('md5').update(data).digest('hex')
  } catch (e) {
    console.error(e.message || e)
    return null
  }
}
