# Minecraft Server Performance Tester

Toolkit untuk melakukan uji beban dan pemantauan performa Minecraft server, lengkap dengan opsi bot bergerak acak untuk eksplorasi world serta pengumpulan metrik TPS, world generation, dan entity.

## Fitur

- Mode skenario siap pakai: quick, light, medium, heavy.
- Mode kustom: jumlah bot, durasi (menit atau unlimited), target chunk world-gen, dan tingkat spawn entity.
- Dua mode bot:
  - Simulated: koneksi TCP cepat untuk uji beban ringan.
  - Real moving bots (Mineflayer): bot login sebagai pemain, berjalan acak dengan pathfinding, memicu chunk loading.
- Monitoring TPS via RCON dengan fallback simulasi jika RCON tidak tersedia.
- Auto laporan hasil ke CSV (ringkas) dan JSON (detail) di folder results/.
- Username bot real selalu acak (<=16 karakter) dan spawn berjeda 3 detik per bot untuk menghindari throttle.
- Logging proses bot real ke terminal untuk memudahkan debugging.

## Persyaratan

- Windows 10/11 atau Linux.
- Python 3.9+.
- Node.js 22.x untuk bot real (Mineflayer).
- Minecraft server:
  - server.properties: online-mode=false.
  - server.properties: enforce-secure-profile=false.
  - RCON diaktifkan untuk monitoring TPS (opsional tapi direkomendasikan).

## Struktur Berkas

- minecraft_tester.py — Orchestrator utama (menu interaktif, monitoring, laporan).
- wander_bot.js — Bot Mineflayer yang bergerak acak (real moving bots).
- run_test.bat — Runner Windows untuk menjalankan tester.
- config.json — Konfigurasi server, mode bot, dan skenario uji.
- results/ — Folder keluaran laporan CSV & JSON.

## Instalasi

### 1) Python dan dependency
- Python 3.9+ harus tersedia pada PATH.
- Tidak ada paket Python tambahan wajib; script akan berjalan langsung.

### 2) Node.js 22.x dan dependency bot
- Install Node.js 22.x.
- Di folder proyek, inisialisasi dan pasang dependency:
  - npm init -y
  - npm install mineflayer mineflayer-pathfinder

### 3) Konfigurasi server.properties
- Pastikan:
  - enable-rcon=true
  - rcon.port=25835 (atau port lain)
  - rcon.password=<password_rcon>
  - online-mode=false
  - enforce-secure-profile=false
- Restart server setelah perubahan.

## Konfigurasi

config.json contoh:
```json
{
  "server": {
    "host": "premium8.alstore.space",
    "port": 25569,
    "rcon_port": 25835,
    "rcon_password": "changeme"
  },
  "bot_mode": "real_moving", 
  "scenarios": {
    "quick":   { "player_count": 2,  "duration_minutes": 1,  "world_gen_chunks": 10,  "entity_spawn_rate": "low",    "description": "Quick test - 1 minute" },
    "light":   { "player_count": 3,  "duration_minutes": 5,  "world_gen_chunks": 30,  "entity_spawn_rate": "low",    "description": "Light load - 3 players, 5 min" },
    "medium":  { "player_count": 6,  "duration_minutes": 8,  "world_gen_chunks": 60,  "entity_spawn_rate": "medium", "description": "Medium load - 6 players, 8 min" },
    "heavy":   { "player_count": 10, "duration_minutes": 12, "world_gen_chunks": 100, "entity_spawn_rate": "high",   "description": "Heavy load - 10 players, 12 min" }
  }
}
```

Catatan:
- bot_mode: “real_moving” untuk Mineflayer, “simulated” untuk koneksi cepat.
- Password RCON wajib benar agar TPS real bisa dibaca.

## Menjalankan

### Windows (disarankan)
- Double‑click run_test.bat.
- Pilih skenario melalui menu:
  - 1–4: skenario cepat → berat.
  - 5: custom test.
  - 6: unlimited test (Ctrl+C untuk berhenti).
  - 7: multiple (jalankan beberapa skenario berurutan).
  - 0: exit.

### Manual (opsional)

Menjalankan bot real satu per satu:
```bash
node wander_bot.js --host premium8.alstore.space --port 25569 --username W_Test01
```

Menjalankan orchestrator langsung:
```bash
python minecraft_tester.py
```

## Perilaku Bot Real (Mineflayer)

- Otentikasi: offline.
- Versi protokol: diset eksplisit ke 1.21.8 agar handshake cocok.
- Username: otomatis acak, panjang ≤16 karakter, karakter A‑Z a‑z 0‑9 dan underscore.
- Movement: memilih target acak berkala dalam radius ±96 blok, pathfinding menuju target, memicu chunk load dan world generation.
- Spawn delay: 3–4 detik per bot untuk menghindari throttle login bawaan server.

## Output

- results/test_summary_YYYYMMDD_HHMMSS.csv — Ringkasan per skenario:
  - Scenario, Bot_Mode, Bots, Duration_Min, Avg_TPS, Min_TPS, Max_TPS, Chunks_Per_Sec, Entities_Per_Sec, Connected_Bots, Test_Time.
- results/detailed_results_YYYYMMDD_HHMMSS.json — Detail lengkap tiap skenario.

## Command Penting

- Jalankan tester (Windows):
  - run_test.bat
- Jalankan bot manual:
  - node wander_bot.js --host <host> --port <port> --username <nama>
- Audit paket Node (opsional):
  - npm audit fix

## Tips Tuning

- Ingin join bot lebih cepat: atur connection-throttle di bukkit.yml (nilai -1 menonaktifkan throttle), atau naikkan jeda spawn di orchestrator.
- Ingin beban lebih berat: naikkan player_count di skenario atau jalankan unlimited test dengan banyak bot.
- Ingin lebih agresif eksplorasi: besarkan radius tujuan di wander_bot.js (mis. 128–160), perhatikan dampak TPS.

## Troubleshooting

- Connection throttled! Please wait before reconnecting:
  - Tanda throttle join aktif; naikkan delay spawn (mis. 4–5 detik) atau ubah bukkit.yml: settings.connection-throttle: -1.
- Failed to decode packet 'serverbound/minecraft:hello':
  - Pastikan wander_bot.js memakai version: '1.21.8' dan auth: 'offline'.
  - Pastikan koneksi langsung ke port Minecraft (tanpa PROXY protocol/TLS di depan).
- This server requires secure profiles:
  - Pastikan enforce-secure-profile=false dan online-mode=false, lalu restart server.
- EBADENGINE saat npm install:
  - Pastikan Node 22.x aktif, lalu reinstall dependency.
- TPS tidak terbaca:
  - Cek enable-rcon=true, port dan password benar, firewall RCON terbuka.
- Bot tidak bergerak:
  - Pastikan mineflayer-pathfinder terpasang dan plugin dimuat; lihat log terminal untuk error pathfinding.

## Catatan Keamanan

- Mode offline‑mode membuka risiko penyamaran identitas; gunakan hanya di lingkungan uji.
- Jangan gunakan bot pada server publik tanpa izin.

## Lisensi

- Script contoh dan README ini bebas digunakan di lingkungan uji internal. Untuk dependensi pihak ketiga (Mineflayer, mineflayer‑pathfinder), ikuti lisensi masing‑masing proyek.

[1](https://github.com/PrismarineJS/mineflayer)
[2](https://www.youtube.com/watch?v=PZ5YmgkZML8)
[3](https://colab.research.google.com/github/PrismarineJS/mineflayer/blob/master/docs/mineflayer.ipynb)
[4](https://codesandbox.io/examples/package/mineflayer)
[5](https://www.youtube.com/watch?v=Giu0ADA5uo8)
[6](https://docs.vultr.com/how-to-setup-a-basic-mineflayer-bot-on-ubuntu-20-04)
[7](https://stackoverflow.com/questions/68390422/my-mineflayer-bot-doesnt-respond-to-my-message)
[8](https://sourceforge.net/projects/mineflayer.mirror/files/4.33.0/README.md/download)
[9](https://codesandbox.io/examples/package/mineflayer-pvp)