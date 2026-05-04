import sys
import json
import yt_dlp

video_id    = sys.argv[1]
lang        = sys.argv[2]
out_template = sys.argv[3]

is_english = lang == "en"
lang_pref  = "en.*" if is_english else f"{lang}.*,en.*"

print(f"[PY-YTDLP-START] videoId={video_id}, lang={lang}, lang_pref={lang_pref}", file=sys.stderr, flush=True)

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
    _err_str = str(e).lower()
    _classify_ytdlp_error = (
        "bot_403" if ("403" in _err_str or "bot" in _err_str or "sign in" in _err_str) else
        "network" if ("network" in _err_str or "connection" in _err_str or "timeout" in _err_str) else
        "not_available" if ("unavailable" in _err_str or "private" in _err_str or "removed" in _err_str) else
        "unknown"
    )
    print(f"[PY-YTDLP-FAIL] videoId={video_id}, lang={lang}, errType={_classify_ytdlp_error}, err={str(e)[:200]}", file=sys.stderr, flush=True)
    print(json.dumps({"success": False, "error": str(e)}))
