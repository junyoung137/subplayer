import sys
import json
import yt_dlp

video_id    = sys.argv[1]
lang        = sys.argv[2]
out_template = sys.argv[3]

is_english = lang == "en"
lang_pref  = "en.*" if is_english else f"{lang}.*,en.*"

ydl_opts = {
    "writeautomaticsub": True,
    "writesubtitles":    True,
    "subtitleslangs":    [lang_pref],
    "subtitlesformat":   "json3/vtt",
    "skip_download":     True,
    "noplaylist":        True,
    "quiet":             True,
    "no_warnings":       True,
    "outtmpl":           out_template,
}

try:
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
