import os, json, csv, glob, time
from datetime import datetime

def load_bot_stats(folder):
  stats = []
  for fp in glob.glob(os.path.join(folder, "*.json")):
    try:
      with open(fp, "r", encoding="utf-8") as f:
        s = json.load(f)
        start = float(s.get("startTime") or 0)
        end = float(s.get("endTime") or start)
        uptime = (end - start) / 1000.0 if end and start else 0.0
        stats.append({
          "username": s.get("username"),
          "distance2d": float(s.get("distance2D", 0)),
          "unique_chunks": int(s.get("uniqueChunks", 0)),
          "stuck": int(s.get("stuckCount", 0)),
          "recover_climb": int(s.get("recoverClimb", 0)),
          "recover_dig": int(s.get("recoverDig", 0)),
          "goals": int(s.get("goalsReached", 0)),
          "new_chunks": int(s.get("newChunksReached", 0)),
          "uptime_s": float(uptime)
        })
    except Exception:
      pass
  return stats

def write_summary(stats, out_dir, ts):
  os.makedirs(out_dir, exist_ok=True)
  csv_path = os.path.join(out_dir, f"bot_stats_summary_{ts}.csv")
  with open(csv_path, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["username","distance2d","unique_chunks","stuck","recover_climb","recover_dig","goals","new_chunks","uptime_s"])
    for s in stats:
      w.writerow([s["username"], f"{s['distance2d']:.2f}", s["unique_chunks"], s["stuck"], s["recover_climb"], s["recover_dig"], s["goals"], s["new_chunks"], f"{s['uptime_s']:.1f}"])
  return csv_path

def print_summary(stats):
  print("\n🧭 Per-bot summary")
  for s in stats:
    print(f"  {s['username']}: dist {s['distance2d']:.1f}, chunks {s['unique_chunks']}, stuck {s['stuck']} (climb {s['recover_climb']}/dig {s['recover_dig']}), goals {s['goals']}, new {s['new_chunks']}, uptime {s['uptime_s']:.0f}s")

def main():
  folder = os.path.join("results", "bot_stats")
  if not os.path.isdir(folder):
    print("No bot_stats folder found")
    return
  stats = load_bot_stats(folder)
  if not stats:
    print("No per-bot stats found")
    return
  ts = datetime.now().strftime("%Y%m%d_%H%M%S")
  csv_path = write_summary(stats, "results", ts)
  print_summary(stats)
  print(f"\n🧾 Bot stats summary: {csv_path}")

if __name__ == "__main__":
  main()
