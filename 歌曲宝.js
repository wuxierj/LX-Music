/*!
 * @name 歌曲宝音源
 * @description 通过 gequbao.com 解析在线播放直链
 * @version 1.0.0
 * @author trae
 * @homepage https://www.gequbao.com
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx

const HOST = 'https://www.gequbao.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_CANDIDATES = 4
const URL_TTL = 5 * 60 * 1000

/* ---------------- cookie ---------------- */

const jar = {}
const cookieHeader = () => Object.keys(jar).map(k => k + '=' + jar[k]).join('; ')
const storeCookies = headers => {
  if (!headers) return
  let sc
  for (const key in headers) {
    if (String(key).toLowerCase() === 'set-cookie') { sc = headers[key]; break }
  }
  if (!sc) return
  if (!Array.isArray(sc)) sc = [sc]
  for (const line of sc) {
    const kv = String(line).split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
}

/* ---------------- http ---------------- */

const http = (path, opts = {}) => new Promise((resolve, reject) => {
  const headers = { 'User-Agent': UA, Accept: opts.accept || '*/*' }
  if (opts.headers) Object.assign(headers, opts.headers)
  const cookie = cookieHeader()
  if (cookie) headers.cookie = cookie
  const options = {
    method: opts.method || 'GET',
    timeout: opts.timeout || 8000,
    headers,
  }
  if (opts.form) options.form = opts.form
  request(HOST + path, options, (err, resp) => {
    if (err) return reject(err)
    storeCookies(resp.headers)
    resolve(resp)
  })
})

/* ---------------- parse ---------------- */

const unescapeHtml = str => String(str)
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

const decodeUnicode = str => String(str)
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

const parseAppData = html => {
  const m = /window\.appData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/.exec(html)
  if (!m) return null
  try {
    return JSON.parse(m[1].replace(/\\u0022/g, '"'))
  } catch (err) {
    return null
  }
}

const parseSearchHtml = html => {
  const list = []
  const seen = {}
  const re = /<a href="\/music\/(\d+)"[^>]*title="([^"]+)"/g
  let r
  while ((r = re.exec(html))) {
    const id = r[1]
    if (seen[id]) continue
    seen[id] = true
    list.push({ id, title: unescapeHtml(r[2]) })
  }
  return list
}

/* ---------------- search ---------------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const searchBySuggest = async keyword => {
  const resp = await http('/api/pre-s', { method: 'POST', form: { keyword }, timeout: 8000 })
  const body = resp.body
  if (!body || body.code !== 1 || !body.data || !body.data.data) return []
  const items = body.data.data['1'] || []
  return items
    .filter(it => it && it.business_key)
    .map(it => ({ id: String(it.business_key), title: String(it.keyword || '') }))
}

const searchByPage = async keyword => {
  const encoded = encodeURIComponent(keyword)
  let resp = await http('/s/' + encoded, { accept: 'text/html', timeout: 8000 })
  let list = parseSearchHtml(String(resp.body || ''))
  if (list.length) return list

  resp = await http('/api/s', { method: 'POST', form: { keyword }, timeout: 8000 })
  const body = resp.body || {}
  if (body.code === 2 && body.data && body.data.k) {
    for (let i = 0; i < 5; i++) {
      await sleep(800)
      const q = await http('/api/query-map', { method: 'POST', form: { keyword: body.data.k }, timeout: 8000 })
      if (q.body && q.body.code === 1) break
    }
  }
  resp = await http('/s/' + encoded, { accept: 'text/html', timeout: 8000 })
  return parseSearchHtml(String(resp.body || ''))
}

const searchCandidates = async keyword => {
  let list = []
  try {
    list = await searchBySuggest(keyword)
  } catch (err) {}
  if (!list.length) list = await searchByPage(keyword)
  return list
}

/* ---------------- match ---------------- */

const norm = str => String(str || '')
  .toLowerCase()
  .replace(/[\s\-_/\\()（）\[\]【】.。,，!！?？'"“”‘’·:：]+/g, '')

const BAD_WORDS = /伴奏|纯音乐|翻唱|cover|remix|dj|片段|铃声|消音|和声|karaoke/i

const score = (item, name, singerTokens, rawName) => {
  const target = norm(name)
  const title = norm(item.title)
  if (!target || title.indexOf(target) < 0) return -1
  let s = title.indexOf(target) === 0 ? 40 : 25
  if (title === target) s += 30
  for (const token of singerTokens) {
    if (token && title.indexOf(token) > -1) s += 12
  }
  if (BAD_WORDS.test(item.title) && !BAD_WORDS.test(rawName)) s -= 40
  s -= Math.min(12, item.title.length / 6)
  return s
}

const rank = (list, name, singer) => {
  const tokens = String(singer || '').split(/[、&;；,\/|，]+/).map(norm).filter(Boolean)
  const seen = {}
  return list
    .filter(it => {
      if (seen[it.id]) return false
      seen[it.id] = true
      return true
    })
    .map(it => ({ item: it, s: score(it, name, tokens, name) }))
    .filter(it => it.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map(it => it.item)
}

/* ---------------- resolve ---------------- */

const resolveOne = async (id, name) => {
  const page = await http('/music/' + id, { accept: 'text/html', timeout: 8000 })
  const html = typeof page.body === 'string' ? page.body : ''
  const data = parseAppData(html)
  if (!data || !data.play_id) throw new Error('页面信息缺失')
  const title = decodeUnicode(data.mp3_title || '')
  if (title) {
    const nt = norm(title)
    const nn = norm(name)
    if (nt && nn && nt.indexOf(nn) < 0 && nn.indexOf(nt) < 0) throw new Error('歌曲不匹配')
  }

  const resp = await http('/member/common-play-url', {
    method: 'POST',
    form: { id: data.play_id, purpose: 'play' },
    timeout: 8000,
  })
  const body = resp.body
  if (!body || body.code !== 1 || !body.data || typeof body.data.url !== 'string') {
    throw new Error((body && body.msg) || '获取播放链接失败')
  }
  const url = body.data.url
  if (!/^https?:\/\//.test(url)) throw new Error('无效链接')
  return url
}

/* ---------------- cache ---------------- */

const cache = {}
const inflight = {}

const getMusicUrl = async (musicInfo, quality) => {
  const name = String(musicInfo.name || '').trim()
  const singer = String(musicInfo.singer || '').trim()
  const key = musicInfo.source + '_' + musicInfo.songmid + '_' + name

  const hit = cache[key]
  if (hit && hit.expire > Date.now()) return hit.url
  if (inflight[key]) return inflight[key]

  const task = (async () => {
    const deadline = Date.now() + 15000
    const items = await searchCandidates((name + ' ' + singer).trim())
    const ranked = rank(items, name, singer)
    if (!ranked.length) throw new Error('未找到匹配歌曲')

    let lastErr
    for (const item of ranked.slice(0, MAX_CANDIDATES)) {
      if (Date.now() > deadline) break
      try {
        const url = await resolveOne(item.id, name)
        cache[key] = { url, expire: Date.now() + URL_TTL }
        return url
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new Error('解析播放链接失败')
  })()

  inflight[key] = task
  try {
    return await task
  } finally {
    delete inflight[key]
  }
}

/* ---------------- registry ---------------- */

on(EVENT_NAMES.request, ({ action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('不支持的操作: ' + action))
  return getMusicUrl(info.musicInfo, info.type)
})

const sources = {}
;['kw', 'kg', 'tx', 'wy', 'mg'].forEach(key => {
  sources[key] = {
    type: 'music',
    actions: ['musicUrl'],
    qualitys: ['128k'],
  }
})

send(EVENT_NAMES.inited, { sources })