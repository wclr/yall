import fs from 'fs-extra'
import { join } from 'path'
import { execSync } from 'child_process'

for (let i = 1; i <= 5; i++) {
  fs.copySync('package.json', join('/test', 'package' + i, 'package.json'))
  fs.copySync('yarn.lock', join('/test', 'package' + i, 'yarn.lock'))
}

execSync('node ../src/yall', {
  cwd: '/test', stdio: 'inherit',
  env: {
    FORCE_COLOR: 'true',
    PATH: process.env.PATH
  }  
})
