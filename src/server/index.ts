import 'dotenv/config.js'
import 'express-async-errors'

import path from 'path'
import express, { NextFunction, Request, Response } from 'express'
import { existsSync, promises as fs } from 'fs'

import * as Dev from './dev/index.js'
import * as Bundle from './bundle.js'
import { staticDir, siteConfig, env, filesDir, sourceDir, buildDir, hydrateDir, clientDir, SiteConfig, cacheDir } from './config.js'
import { resolveFile } from './files.js'
import { render, resolveAsset, validScriptBundles, validStyleBundles } from './render.js'
import { ensureLocale } from './i18n.js'
import { buildSsrFile, ssrBuildFile } from './lib/ssr.js'
import { requireLatestOptional } from './lib/fs.js'

import pathToRegexp from 'express/node_modules/path-to-regexp/index.js'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)


const router = express.Router({ strict: true })
export default router


let rewrites: SiteConfig['rewrites'] = {}

router.use( express.static(hydrateDir, { redirect: false }) )
router.use( express.static(staticDir, { redirect: false }) )

if (env.production) {
  //
  // For non-static sites
  // Here we rewrite some urls to hit their generated static assets
  //
  rewrites = require(path.join(cacheDir, 'rewrites.json'))
  router.use((req, _res, next) => {
    // TODO: Support plural i18n
    for (let [from, to] of Object.entries(rewrites)) {
      if (req.url === from) {
        req.url = to
        break
      }
    }
    next()
  })
  router.use( express.static(buildDir, { redirect: false }) )
}

router.post('/lrpc', express.json(), async (req, res) => {
  const ns = req.body.namespace
  if (!ns.match(/\.server$/)) return res.sendStatus(404)

  if (env.development) {
    // Warning: Some logic duplicated from ssr.ts
    let ssrFile = path.join(clientDir, `${ns}.js`)
    if (!existsSync(ssrFile)) ssrFile = path.join(clientDir, `${ns}.ts`)
    if (!existsSync(ssrFile)) {
      console.error('No such js/ts file:', `client/${ns}`)
      return res.sendStatus(404)
    }

    const site = siteConfig()
    await buildSsrFile(ssrFile, site)
  }

  const rpcs = requireLatestOptional(ssrBuildFile(`${ns}.js`)) // TODO: SECURITY
  const rpc = rpcs && rpcs.module[req.body.method]
  if (!rpc) return res.sendStatus(404)

  const result = await rpc(...req.body.args)
  return res.send(result)
})


type ReParams = Array<{ name: string, optional: boolean, offset: number }>

router.all('/*', ensureLocale(), express.urlencoded({ extended: false }), async (req, res, next) => {
  const isGet  = req.method === 'GET'
  const isPost = req.method === 'POST'
  if (!isGet && !isPost) {
    return next()
  }

  let filename: string = ''

  const site = siteConfig({ scanRewrites: !env.production })
  const plainPath = req.locale ? req.path.replace(`/${req.locale}`, '') : req.path

  if (!env.production) {
    rewrites = site.rewrites
  }

  rewrite:
  for (let [pattern, file] of Object.entries(rewrites)) {
    let p1: ReParams, p2: ReParams
    const re1 = [pathToRegexp(pattern.replace(/\.html$/, ''), p1 = []), p1] as const
    const re2 = [pathToRegexp(pattern, p2 = []), p2] as const

    for (let [re, params] of [re1, re2]) {
      const match = req.path.match(re)

      if (match) {
        params.forEach((param, i) => {
          req.params[param.name] = match[i+1]!
        })
        filename = file
        break rewrite
      }
    }
  }

  try {
    log(`\n[Lancer] ${isGet ? 'GET' : 'POST'}`, req.url)
    filename = filename || resolveAsset(plainPath)
  }
  catch (err) {
    log('         -->', err.message)
    res.sendStatus(404)
    return
  }

  if ( isGet && validScriptBundles[filename] ) {
    log('         -->', filename.replace(sourceDir+'/', ''), '(bundle)')
    const result = await Bundle.bundleScript(filename, site)
    res.set({ 'Content-Type': 'application/javascript' })
    res.send(Buffer.from(result).toString('utf8'))
  }
  else if ( isGet && validStyleBundles[filename] ) {
    log('         -->', filename.replace(sourceDir+'/', ''), '(bundle)')
    const result = await Bundle.bundleStyle(sourceDir, filename)
    res.set({ 'Content-Type': 'text/css' })
    res.send(result === null ? '!error' : result)
  }
  else if ( isGet && filename.startsWith(filesDir) ) {
    const file = await resolveFile(filename, {
      site,
      preview: queryStringVal('preview')
    })
    if (file) {
      log('         -->', file.replace(sourceDir+'/', ''))
      res.sendFile(file)
    }
    else {
      res.sendStatus(404)
    }
  }
  else if ( filename.match(/\.html$/) && existsSync(filename) ) {
    await renderHtml(req, res, next, { plainPath, filename })
  }
  else if ( filename.match(/\.html$/) ) {
    const folderIndex = filename.replace(/\.html$/, '/index.html')
    if (existsSync(folderIndex)) {
      await renderHtml(req, res, next, { plainPath, filename: folderIndex })
    }
    else notFound()
  }
  else {
    notFound()
  }

  function notFound() {
    if (existsSync(filename)) {
      log(' >> Access denied', plainPath)
    }
    else {
      log(' >> No such file', plainPath)
    }
    res.sendStatus(404)

    if (env.development) {
      Dev.handle404(filename)
    }
  }

  function queryStringVal(key: string): string | undefined {
    let val = req.query[key]
    return typeof val === 'string' ? val : undefined
  }
})

async function renderHtml(req: Request, res: Response, next: NextFunction, { plainPath, filename }: {
  plainPath: string
  filename: string
}) {
  log('         -->', filename.replace(sourceDir+'/', ''))
  const htmlSrc = await fs.readFile(filename, 'utf8')
  const site = siteConfig()
  const {isSsr, html} = await render(htmlSrc, {
    req,
    site,
    cache: {},
    locale: req.locale || site.locales[0]!,
    plainPath,
    filename,
    location: new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`)
  })

  if (req.method === 'POST' && !isSsr) {
    next()
  }
  else {
    res.set({ 'Content-Type': 'text/html' })
    res.send(html)
  }
}

function log(...args: any[]) {
  if (!env.test) {
    console.log(...args)
  }
}
