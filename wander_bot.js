const { EventEmitter } = require('events')
EventEmitter.defaultMaxListeners = 50  // REDUCED from 100

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

// ==== FAR TRAVEL EXPLORATION CONFIG ====
const CHUNK_SIZE = 16
const NAME_PREFIX = 'W_'

// Far travel settings - each bot goes much farther
const FAR_DISTANCE = 20000               // Target 20,000 blocks from spawn (much farther than 5000)
const BASE_TIMEOUT_MS = 200000           // Increased timeout for very long journeys (3+ minutes)
const BASE_STUCK_MS = 30000              // More time to get unstuck on long treks
const BASE_CHAT_MS = 30000               // Much less chat spam
const STUCK_MIN_MOVE = 1.5               // More sensitive to detect stalls

// Movement optimization - keep the working config but adjust for distance
const GOAL_TOLERANCE = 10                // Less precise = faster for long distance
const RING_MAX = 25                      // Larger search radius
const SAMPLES_PER_RING = 10              // More samples for better coverage

// Directional spreading - distribute bots in 4 directions
const DIRECTIONS = [
  { name: 'NORTH', dx: 0, dz: -1 },
  { name: 'EAST',  dx: 1, dz:  0 },
  { name: 'SOUTH', dx: 0, dz:  1 },
  { name: 'WEST',  dx: -1, dz:  0 }
]

// Disable unnecessary features
const ENABLE_CHAT = false        // Disable chat completely
const ENABLE_STATS = true        // Keep stats but less frequent
const STATS_INTERVAL = 15000     // INCREASED from 6000 (update every 15s)

// ==== Args ====
function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}

const BOTS_PER_PROCESS = parseInt(arg('bots-per-process', '5'), 10)
const START_BOT_ID = parseInt(arg('start-id', '0'), 10)
const SERVER_HOST = arg('host', '127.0.0.1')
const SERVER_PORT = parseInt(arg('port', '25565'), 10)

function generateUsername(prefix, id) {
  return `${prefix}${id}`
}

// ==== OPTIMIZED Bot Class ====
class WanderBot {
  constructor(botId, host, port) {
    this.botId = botId
    this.host = host
    this.port = port
    this.username = generateUsername(NAME_PREFIX, botId)
    this.visited = new Set()

    // Minimal metrics
    this.metrics = {
      username: null,
      startTime: null,
      endTime: null,
      distance2D: 0,
      uniqueChunks: 0
    }

    this.lastTrack = null
    this.statTimer = null
    this.spawnPos = null
    this.outwardBearing = null
    this.targetIndex = this.botId % DIRECTIONS.length  // Distribute bots across 4 directions
    this.currentTargetDistance = FAR_DISTANCE     // Target far distance
    this.phase = 1  // Start with far travel phase

    this.TIMEOUT_MS = BASE_TIMEOUT_MS
    this.STUCK_CHECK_MS = BASE_STUCK_MS
  }

  createBot() {
    this.bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      auth: 'offline',
      version: '1.21.1',
      viewDistance: 'tiny',      // Already minimal
      chatLengthLimit: 10,       // REDUCED from 100
      physicsEnabled: true,
      hideErrors: true,          // CHANGED: Hide errors to reduce console spam
      checkTimeoutInterval: 120000,  // INCREASED from 90000
      keepAlive: true,
      closeTimeout: 180000       // INCREASED from 120000
    })

    this.bot.loadPlugin(pathfinder)
    this.bot.setMaxListeners(50)  // REDUCED from 100

    if (this.bot._client) {
      this.bot._client.setMaxListeners(50)
      // Remove error logging to reduce overhead
    }

    this.setupEventHandlers()
  }

  setupEventHandlers() {
    // OPTIMIZED: Only track chunks every 2nd chunk load
    let chunkLoadCounter = 0
    this.bot.on('chunkColumnLoad', (pt) => {
      if (++chunkLoadCounter % 2 === 0) {  // Only count every 2nd chunk
        this.visited.add(`${pt.x}:${pt.z}`)
      }
    })

    this.bot.once('spawn', async () => {
      console.log(`[${this.username}] Spawned`)
      await this.onSpawn()
    })

    // Simplified error handlers
    this.bot.on('kicked', () => this.cleanup())
    this.bot.on('end', () => this.cleanup())
    this.bot.on('error', () => {})  // Ignore errors silently
  }

  cleanup() {
    try {
      this.stopStatTimers()
      if (ENABLE_STATS) this.writeBotStats(true)
    } catch {}
  }

  async onSpawn() {
    try {
      // OPTIMIZED: Minimal movement config
      const mcData = require('minecraft-data')(this.bot.version)
      const moves = new Movements(this.bot, mcData)

      // Ultra minimal movement
      moves.allow1by1towers = false     // DISABLED (saves CPU)
      moves.allowParkour = false
      moves.canDig = false
      moves.allowSprinting = false      // DISABLED (saves CPU)
      moves.scafoldingBlocks = []
      moves.maxDropDown = 4             // REDUCED from default

      if (this.bot.pathfinder && this.bot.pathfinder.setMovements) {
        this.bot.pathfinder.setMovements(moves)
      }

      this.spawnPos = this.bot.entity.position.clone()

      // Calculate direction for this bot (spread across 4 directions)
      const direction = DIRECTIONS[this.targetIndex]

      // Set bearing towards far distance in this direction
      this.outwardBearing = Math.atan2(direction.dz, direction.dx)

      // Store target position for debugging/logging
      this.targetX = this.spawnPos.x + direction.dx * this.currentTargetDistance
      this.targetZ = this.spawnPos.z + direction.dz * this.currentTargetDistance

      console.log(`[${this.username}] Target: ${direction.name} (${this.targetX.toFixed(0)}, ${this.targetZ.toFixed(0)})`)

      this.metricInit()
      if (ENABLE_STATS) this.startStatTimers()

      await this.sleep(2000 + this.botId * 300)  // Longer initial wait
      await this.exploreLoop()  // Skip initial scatter for efficiency

    } catch (err) {
      // Silent fail
    }
  }

  metricInit() {
    this.metrics.username = this.bot.username
    this.metrics.startTime = Date.now()
    this.lastTrack = this.bot.entity.position
  }

  startStatTimers() {
    // OPTIMIZED: Much less frequent updates
    this.statTimer = setInterval(() => {
      try {
        this.trackDistanceTick()
        this.metrics.uniqueChunks = this.visited.size
        this.writeBotStats(false)
      } catch {}
    }, STATS_INTERVAL)  // 15s instead of 6s
  }

  stopStatTimers() {
    if (this.statTimer) {
      clearInterval(this.statTimer)
      this.statTimer = null
    }
  }

  trackDistanceTick() {
    const p = this.bot.entity?.position
    if (!p || !this.lastTrack) return

    const dx = p.x - this.lastTrack.x
    const dz = p.z - this.lastTrack.z
    this.metrics.distance2D += Math.sqrt(dx * dx + dz * dz)
    this.lastTrack = { x: p.x, z: p.z }
  }

  writeBotStats(finalize = false) {
    if (finalize) this.metrics.endTime = Date.now()

    const STATS_DIR = path.join(process.cwd(), 'results', 'bot_stats')
    fs.mkdirSync(STATS_DIR, { recursive: true })

    const jsonPath = path.join(STATS_DIR, `${this.bot.username}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(this.metrics))  // No pretty print
  }

  currentChunk() {
    const p = this.bot.entity.position
    return {
      cx: Math.floor(p.x / CHUNK_SIZE),
      cz: Math.floor(p.z / CHUNK_SIZE),
      y: Math.floor(p.y)
    }
  }

  chunkCenter(cx, cz, y) {
    return {
      x: cx * CHUNK_SIZE + 8,  // Direct offset instead of division
      y,
      z: cz * CHUNK_SIZE + 8
    }
  }

  findFrontierSimple() {
    const { cx, cz, y } = this.currentChunk()

    // OPTIMIZED: Simple expanding square search instead of complex ring
    for (let r = 1; r <= RING_MAX; r++) {
      // Check 4 cardinal directions only
      const checks = [
        [cx + r, cz],
        [cx - r, cz],
        [cx, cz + r],
        [cx, cz - r]
      ]

      for (const [tx, tz] of checks) {
        if (!this.visited.has(`${tx}:${tz}`)) {
          return {
            target: this.chunkCenter(tx, tz, y),
            chunk: { tx, tz }
          }
        }
      }
    }

    // Fallback: Random direction
    const angle = Math.random() * Math.PI * 2
    const dist = RING_MAX * CHUNK_SIZE
    const p = this.bot.entity.position
    return {
      target: {
        x: p.x + Math.cos(angle) * dist,
        y: p.y,
        z: p.z + Math.sin(angle) * dist
      },
      chunk: null
    }
  }

  planarDist(a, b) {
    const dx = a.x - b.x
    const dz = a.z - b.z
    return Math.sqrt(dx * dx + dz * dz)
  }

  async gotoWithTimeout(pos) {
    return new Promise((resolve) => {
      let done = false
      this.bot.pathfinder.setGoal(null)
      const goal = new GoalNear(pos.x, pos.y, pos.z, GOAL_TOLERANCE)
      this.bot.pathfinder.setGoal(goal, false)

      const timer = setTimeout(() => {
        if (!done) {
          done = true
          this.bot.pathfinder.setGoal(null)  // Stop pathfinding
          resolve(false)
        }
      }, this.TIMEOUT_MS)

      const iv = setInterval(() => {
        if (!this.bot.pathfinder.isMoving()) {
          clearInterval(iv)
          clearTimeout(timer)
          if (!done) {
            done = true
            resolve(true)
          }
        }
      }, 2000)  // INCREASED from 1500
    })
  }

  async exploreLoop() {
    let lastPos = this.bot.entity.position.clone()
    let lastCheck = Date.now()
    let cycle = 0

    while (true) {
      try {
        // OPTIMIZED: Less frequent event loop yields
        if (++cycle % 10 === 0) await this.yieldEventLoop()

        const now = Date.now()
        if (now - lastCheck >= this.STUCK_CHECK_MS) {
          const cur = this.bot.entity.position.clone()

          // Simple stuck check - no recovery, just new goal
          if (this.planarDist(cur, lastPos) < STUCK_MIN_MOVE) {
            this.bot.pathfinder.setGoal(null)  // Just stop and continue
          }

          lastPos = cur
          lastCheck = now
        }

        // OPTIMIZED: Simple frontier search
        const cand = this.findFrontierSimple()
        if (cand) {
          await this.gotoWithTimeout(cand.target)
          if (cand.chunk) {
            this.visited.add(`${cand.chunk.tx}:${cand.chunk.tz}`)
          }
        }

        // Check if we should switch to local exploration after minimum distance
        if (this.phase === 1) {
          const distanceFromSpawn = this.planarDist(this.bot.entity.position, this.spawnPos)
          if (distanceFromSpawn >= 5000) {  // Minimum 5000 blocks from spawn
            console.log(`[${this.username}] Reached minimum distance of ${Math.floor(distanceFromSpawn)} blocks, switching to local exploration`)
            this.phase = 2
          }
        }

        // INCREASED sleep time
        await this.sleep(2000 + Math.random() * 1000)

      } catch {
        await this.sleep(3000)
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  yieldEventLoop() {
    return new Promise(r => setImmediate(r))
  }
}

// ==== Main ====
async function main() {
  const bots = []

  // Reduce console spam
  console.log(`Starting ${BOTS_PER_PROCESS} bots (W_${START_BOT_ID}-${START_BOT_ID + BOTS_PER_PROCESS - 1})`)

  for (let i = 0; i < BOTS_PER_PROCESS; i++) {
    const botId = START_BOT_ID + i
    const wanderBot = new WanderBot(botId, SERVER_HOST, SERVER_PORT)

    try {
      wanderBot.createBot()
      bots.push(wanderBot)

      if (i < BOTS_PER_PROCESS - 1) {
        await new Promise(r => setTimeout(r, 4000))  // 4s stagger
      }
    } catch (err) {
      console.error(`[W_${botId}] Failed: ${err.message}`)
    }
  }

  console.log(`Process ready with ${bots.length} bots\n`)

  const cleanup = () => {
    bots.forEach((bot) => {
      try {
        bot.cleanup()
        if (bot.bot && bot.bot.quit) bot.bot.quit()
      } catch {}
    })
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

// Reduce error spam
process.on('uncaughtException', () => {})
process.on('unhandledRejection', () => {})

main().catch(() => process.exit(1))