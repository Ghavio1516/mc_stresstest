const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

const CHUNK_SIZE = 16
const RING_MAX = 16
const SAMPLES_PER_RING = 8
const GOAL_TOLERANCE = 2
const TIMEOUT_MS = 45_000

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}

function randomName(prefix = 'W_') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
  let base = ''
  while (base.length < 12) base += chars[Math.floor(Math.random() * chars.length)]
  return (prefix + base).slice(0, 16)
}

const usernameArg = arg('username', '')

const bot = mineflayer.createBot({
  host: arg('host', '127.0.0.1'),
  port: parseInt(arg('port', '25565'), 10),
  username: usernameArg && usernameArg.length >= 3 ? usernameArg : randomName(),
  auth: 'offline',
  version: '1.21.1'
})

bot.loadPlugin(pathfinder)

const visited = new Set()

function chunkKey(cx, cz) {
  return `${cx}:${cz}`
}

bot.on('chunkColumnLoad', (pt) => {
  visited.add(chunkKey(pt.x, pt.z))
})

function currentChunk() {
  const p = bot.entity.position
  return {
    cx: Math.floor(p.x / CHUNK_SIZE),
    cz: Math.floor(p.z / CHUNK_SIZE),
    y: Math.floor(p.y)
  }
}

function chunkCenter(cx, cz, y) {
  return {
    x: cx * CHUNK_SIZE + CHUNK_SIZE / 2,
    y,
    z: cz * CHUNK_SIZE + CHUNK_SIZE / 2
  }
}

function findFrontier(maxRing = RING_MAX, samples = SAMPLES_PER_RING) {
  const { cx, cz, y } = currentChunk()
  for (let r = 1; r <= maxRing; r++) {
    for (let i = 0; i < samples; i++) {
      const theta = (2 * Math.PI * i) / samples
      const tx = cx + Math.round(r * Math.cos(theta))
      const tz = cz + Math.round(r * Math.sin(theta))
      if (!visited.has(chunkKey(tx, tz))) {
        return { target: chunkCenter(tx, tz, y), chunk: { tx, tz } }
      }
    }
  }
  return null
}

async function gotoWithTimeout(pos) {
  return new Promise((resolve) => {
    let done = false
    const goal = new GoalNear(pos.x, pos.y, pos.z, GOAL_TOLERANCE)
    bot.pathfinder.setGoal(goal, false)

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        resolve(false)
      }
    }, TIMEOUT_MS)

    const iv = setInterval(() => {
      if (!bot.pathfinder.isMoving()) {
        clearInterval(iv)
        clearTimeout(timer)
        if (!done) {
          done = true
          resolve(true)
        }
      }
    }, 1000)
  })
}

async function scatterIfAtSpawn() {
  const start = bot.entity.position.clone()
  await new Promise((r) => setTimeout(r, 1500))
  const cur = bot.entity.position
  const dx = cur.x - start.x
  const dy = cur.y - start.y
  const dz = cur.z - start.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist < 3) {
    const radius = 160 + Math.random() * 160
    const angle = Math.random() * Math.PI * 2
    const target = {
      x: cur.x + Math.cos(angle) * radius,
      y: cur.y,
      z: cur.z + Math.sin(angle) * radius
    }
    await gotoWithTimeout(target)
  }
}

async function exploreFrontierLoop() {
  while (true) {
    try {
      const candidate = findFrontier()
      if (!candidate) {
        const p = bot.entity.position
        const far = {
          x: p.x + (Math.random() * 2 - 1) * 256,
          y: p.y,
          z: p.z + (Math.random() * 2 - 1) * 256
        }
        await gotoWithTimeout(far)
      } else {
        const ok = await gotoWithTimeout(candidate.target)
        if (ok) {
          visited.add(chunkKey(candidate.chunk.tx, candidate.chunk.tz))
        }
      }
      await new Promise((r) => setTimeout(r, 1500))
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version)
  const moves = new Movements(bot, mcData)
  moves.allow1by1towers = true
  moves.canDig = true
  bot.pathfinder.setMovements(moves)
  scatterIfAtSpawn().then(() => exploreFrontierLoop())
})

bot.on('message', () => {})
bot.on('kicked', (r) => console.log('kicked:', r))
bot.on('error', (e) => console.log('error:', e))
