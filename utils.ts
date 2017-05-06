import * as fs from 'fs'
import * as rimraf from 'rimraf'
import * as chalk from 'chalk'

export const colors = {
  start: chalk.magenta,
  finish: chalk.magenta,
  warn: chalk.yellow,
  just: chalk.gray,
  error: chalk.red
}

type ColorLog = {[key in keyof typeof colors]: (msg: string) => void}
export const log: ColorLog
  = Object.keys(colors).reduce<ColorLog>((obj, key: keyof typeof colors) =>
    Object.assign(obj, {
      [key]: (message: string) =>
        console.log(colors[key](message))
    }), {} as any)

export const stripAnsi = (str: string) =>
  str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')

export const flatten = <T>(lists: T[][]): T[] =>
  lists.reduce<T[]>((flat, list) => flat.concat(list), [])

export const mkdir = (dir: string) =>
  new Promise((resolve, reject) =>
    fs.access(dir, (err) => {
      err ?
        fs.mkdir(dir, (err) => {
          err ? reject(err) : resolve()
        })
        : resolve()
    })
  )

export const remove = (path: string) =>
  new Promise((resolve, reject) => {
    rimraf(path, (err) => err ? reject(err) : resolve())
  })

export const symlinkDir = (srcpath: string, dstpath: string) =>
  new Promise((resolve, reject) => {
    fs.symlink(srcpath, dstpath, 'dir',
      (err) => err ? reject(err) : resolve()
    )
  })

export const writeFile = (filePath: string, data = '') =>
  new Promise((resolve, reject) => {
    fs.writeFile(filePath, data, 'utf-8',
      (err) => err ? reject(err) : resolve()
    )
  })

export function queue<T, U>(
  items: U[],
  promiseProducer: (result: U) => Promise<T>,
  concurrency: number,
): Promise<Array<T>> {
  concurrency = Math.min(concurrency, items.length)
  const results: T[] = []
  const total = items.length
  items = items.slice()
  return new Promise((resolve, reject) => {
    const next = () => {
      promiseProducer(items.shift()!)
        .then(function (result) {
          results.push(result)
          if (results.length === total) {
            resolve(results)
          } else if (items.length) {
            next()
          }
        }, reject);
    }
    Array.from(Array(concurrency).keys()).forEach(next)
  })
}
