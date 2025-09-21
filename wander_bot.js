// wander_bot.js
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals
const crypto = require('crypto')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}
function randomName(prefix = 'W_') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
  let base = ''
  while (base.length < 12) base += chars[Math.floor(Math.random() * chars.length)]
  // prefix (2) + base (<=14) <= 16
  return (prefix + base).slice(0, 16)
}

const usernameArg = arg('username', '')
const bot = mineflayer.createBot({
  host: process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host')+1] : '127.0.0.1',
  port: parseInt(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port')+1] : '25565', 10),
  username: process.argv.includes('--username') ? process.argv[process.argv.indexOf('--username')+1] : randomName(),
  auth: 'offline',
  version: '1.21.1'
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version)
  const move = new Movements(bot, mcData)
  move.allow1by1towers = true
  move.canDig = true
  bot.pathfinder.setMovements(move)

  function randomGoal(radius = 96, maxDY = 8) {
    const p = bot.entity.position
    const dx = Math.floor((Math.random() * 2 - 1) * radius)
    const dz = Math.floor((Math.random() * 2 - 1) * radius)
    const dy = Math.floor((Math.random() * 2 - 1) * maxDY)
    return new GoalNear(p.x + dx, p.y + dy, p.z + dz, 1)
  }

  ;(async () => {
    while (true) {
      try {
        bot.pathfinder.setGoal(randomGoal(), false)
        await new Promise(r => setTimeout(r, 10000 + Math.random() * 15000))
      } catch (_) {
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  })()
})

bot.on('message', (json) => { /* swallow formatting issues */ })
bot.on('kicked', (r) => console.log('kicked:', r))
bot.on('error', (e) => console.log('error:', e))
