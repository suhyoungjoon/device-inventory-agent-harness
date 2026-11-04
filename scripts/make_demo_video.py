"""시연 동영상 후처리: 장면 webm(v1~v6)을 한 편의 mp4로 (시연 동영상 지시서 C · 최종 제출용 지시서 C).

- 장면마다 scene-<id>.marks.json의 AI 대기 구간만 배속한다. 대기 구간은 잘라 내지 않는다(정직한 편집).
  배속은 구간 길이에 맞춘다: 짧은 대기는 기본 6배속, 1분이 넘는 대기는 12~24배속(구간이 길수록 빠르게, 5분 이내에 맞추려고).
  배속하는 동안 화면 오른쪽 위에 그 구간의 실제 배율 "실제 호출 · N배속"을 띄운다(가짜 AI 테이크면 "가짜 AI · N배속").
  로그 다시 보기·자막 구간은 대기 구간 밖이라 1배속 그대로다.
- 맨 앞에 제목 카드(과제명, 실제 호출 여부, 녹화 날짜, 로그 태그 범례 Planning · Tool Call · Self-Correction).
- 출력: 1920×1080 · H.264 · 30fps mp4, 소리 없음. 끝나면 제출 기준(5분 이내 · 500MB 이하 · 1080p H.264 30fps)을 점검하고
  넘으면 장면별 길이를 출력하고 실패로 끝낸다(파일은 남긴다).

    python -m scripts.make_demo_video [--dir runs/recordings] [--take <이름>] [--speed 6] [--long-speed 12-24]
                                      [--out 사번_성명_시연영상.mp4]

녹화(`node scripts/record_demo.mjs --allow-live --scenes v1,v2,v3,v4,v5,v6`) 뒤에 한 번 돌린다. ffmpeg가 없으면 설치 방법을 안내하고 멈춘다.
"""

import argparse
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENES = ["v1", "v2", "v3", "v4", "v5", "v6"]
FONTS = ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
         "/usr/share/fonts/truetype/nanum/NanumGothic.ttf", "C:/Windows/Fonts/malgun.ttf"]
TITLE = "출동 배정 최적화 · 하네스 기반 AI 에이전트 시연"
TAGS = [("Planning", "0x2a78d6"), ("Tool Call", "0x0ca30c"), ("Self-Correction", "0xd9730d")]   # record_demo.mjs와 같은 색
MIN_FAST = 3.0      # 이보다 짧은 대기는 배속하지 않는다 (배속 표시가 깜빡이기만 한다)
MERGE_GAP = 1.5     # 대기 구간 사이가 이보다 가까우면 하나로 묶는다 (단계 사이 클릭)
LONG_WAIT = 60.0    # 이보다 긴 대기는 구간 길이에 맞춰 더 빠르게
LONG_TARGET = 10.0  # 긴 대기 하나가 영상에서 차지할 목표 초 (배율 = 길이 ÷ 이 값, long-speed 범위 안)
W, H, FPS = 1920, 1080, 30
MAX_SECONDS, MAX_BYTES = 300, 500 * 1024 * 1024   # 제출 기준: 5분 이내, 500MB 이하


def need_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    sys.exit("ffmpeg가 없습니다. 설치 후 다시 실행하세요: macOS `brew install ffmpeg`, Ubuntu `sudo apt install ffmpeg`, "
             "Windows `winget install Gyan.FFmpeg`")


def font_file(given: str | None) -> str:
    for f in ([given] if given else []) + FONTS:
        if f and Path(f).is_file():
            return f
    sys.exit("한글 글꼴을 찾지 못했습니다. --font로 .ttf/.ttc 경로를 주세요")


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = (int(x) for x in s["r_frame_rate"].split("/"))
    return {"codec": s["codec_name"], "width": s["width"], "height": s["height"], "fps": num / den,
            "seconds": float(d["format"]["duration"])}


def duration(path: Path) -> float:
    return probe(path)["seconds"]


def speed_for(length: float, base: float, long_range: tuple[float, float], target: float = LONG_TARGET) -> float:
    """구간 길이에 맞춘 배율: 짧은 대기는 base, 1분이 넘으면 길이 ÷ target초를 long_range 안으로 (정수)."""
    if length <= LONG_WAIT:
        return base
    lo, hi = long_range
    return float(min(hi, max(lo, math.ceil(length / target))))


def segments(marks: list[dict], total: float) -> list[tuple[float, float, bool]]:
    """[(시작, 끝, 배속 여부)]. 가까운 대기 구간은 묶고, 짧은 대기는 그대로 둔다."""
    fast: list[list[float]] = []
    for m in sorted(marks, key=lambda m: m["start"]):
        s, e = max(0.0, m["start"]), min(total, m["end"])
        if e <= s:
            continue
        if fast and s - fast[-1][1] <= MERGE_GAP:
            fast[-1][1] = max(fast[-1][1], e)
        else:
            fast.append([s, e])
    fast = [f for f in fast if f[1] - f[0] >= MIN_FAST]
    out, t = [], 0.0
    for s, e in fast:
        if s > t:
            out.append((t, s, False))
        out.append((s, e, True))
        t = e
    if t < total:
        out.append((t, total, False))
    return out


def esc(text: str) -> str:
    """drawtext 문자열 이스케이프 (작은따옴표 안)."""
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace("%", "\\%")


def align(marks: list[dict], wall: float | None, total: float) -> tuple[list[dict], float]:
    """대기 구간 시각(벽시계, 장면 시작부터 초)을 영상 시간으로. 긴 녹화는 영상이 벽시계보다 조금씩 늘어나므로
    (예: 실제 635초 → 영상 707초) 장면 전체 비율로 늘려 맞춘다. 비율이 이상하면(0.8~1.3 밖) 그대로 둔다."""
    k = total / wall if wall else 1.0
    if not 0.8 <= k <= 1.3:
        k = 1.0
    return [{**m, "start": m["start"] * k, "end": m["end"] * k} for m in marks], k


def encode_scene(src: Path, marks: list[dict], dst: Path, base: float, long_range: tuple[float, float],
                 font: str, live: bool, wall: float | None = None, target: float = LONG_TARGET) -> dict:
    total = duration(src)
    marks, stretch = align(marks, wall, total)
    segs = segments(marks, total)
    parts, chains, spans = [], [], []
    for i, (s, e, fast) in enumerate(segs):
        chain = f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS"
        if fast:
            k = speed_for(e - s, base, long_range, target)
            spans.append({"start": round(s, 1), "end": round(e, 1), "speed": k})
            label = esc(f"{'실제 호출' if live else '가짜 AI'} · {k:g}배속")
            chain += (f",setpts=PTS/{k},drawtext=fontfile='{font}':text='{label}':fontsize=36:fontcolor=white"
                      f":box=1:boxcolor=0x141413@0.85:boxborderw=14:x=w-tw-40:y=36")
        chains.append(chain + f",fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease,"
                      f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0xfafafa,setsar=1[p{i}]")
        parts.append(f"[p{i}]")
    graph = ";".join(chains) + f";{''.join(parts)}concat=n={len(parts)}:v=1:a=0,format=yuv420p[out]"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-filter_complex", graph, "-map", "[out]",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-r", str(FPS), "-an", str(dst)], check=True)
    sped = sum(sp["end"] - sp["start"] for sp in spans)
    out = total - sped + sum((sp["end"] - sp["start"]) / sp["speed"] for sp in spans)
    return {"source_seconds": round(total, 1), "sped_seconds": round(sped, 1), "output_seconds": round(out, 1),
            "stretch": round(stretch, 3), "fast_spans": spans}


def title_card(dst: Path, font: str, live: bool, when: str, seconds: float = 5.0) -> None:
    lines = [(TITLE, 64, -130), ("회사 Azure OpenAI 실제 호출" if live else "가짜 AI(리허설) 녹화 — 실제 호출 아님 · 제출용 아님", 40, -30),
             (f"녹화 {when} · AI 대기 구간은 배속 표시와 함께 빨리 감기, 로그는 1배속", 30, 30)]
    draw = [f"drawtext=fontfile='{font}':text='{esc(t)}':fontsize={size}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2+{dy}"
            for t, size, dy in lines]
    # 로그 태그 범례 (자막 앞 색 칩과 같은 색)
    x0, gap = 560, 300
    for i, (name, color) in enumerate(TAGS):
        draw.append(f"drawtext=fontfile='{font}':text='{esc('[' + name + ']')}':fontsize=34:fontcolor=white"
                    f":box=1:boxcolor={color}:boxborderw=12:x={x0 + i * gap}:y=(h/2)+110")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x141413:s={W}x{H}:d={seconds}:r={FPS}",
                    "-vf", f"{','.join(draw)},format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "22",
                    "-r", str(FPS), "-an", str(dst)], check=True)


def check_submission(out: Path, report: dict) -> list[str]:
    """제출 기준 점검. 문제 목록 (비면 통과)."""
    info = probe(out)
    problems = []
    if info["seconds"] > MAX_SECONDS:
        over = info["seconds"] - MAX_SECONDS
        scenes = ", ".join(f"{k} {v['output_seconds']}초" for k, v in report.items())
        problems.append(f"길이 {info['seconds']:.1f}초 > {MAX_SECONDS}초 ({over:.1f}초 초과). 장면별: {scenes}. "
                        "줄이는 순서: v5 → v1 → v2 비교표 (v3·v4 로그 다시 보기는 줄이지 않는다)")
    size = out.stat().st_size
    if size > MAX_BYTES:
        problems.append(f"용량 {size / 1024 / 1024:.1f}MB > 500MB")
    if (info["width"], info["height"]) != (W, H) or info["codec"] != "h264" or round(info["fps"]) != FPS:
        problems.append(f"형식 {info['width']}×{info['height']} · {info['codec']} · {info['fps']:.2f}fps (기준 1920×1080 · h264 · 30fps)")
    return problems


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="시연 장면 → 한 편의 mp4 (대기 구간 배속, 제출 기준 점검)")
    ap.add_argument("--dir", default=str(ROOT / "runs" / "recordings"), help="장면 webm·marks·takes.json이 있는 폴더")
    ap.add_argument("--take", default=None, help="takes.json의 테이크 이름 (없으면 마지막 테이크)")
    ap.add_argument("--speed", type=float, default=6.0, help="짧은 대기(1분 이하)의 배율")
    ap.add_argument("--long-speed", default="12-24", help="1분 넘는 대기의 배율 범위 (구간 길이 ÷ --long-target초를 이 범위 안으로)")
    ap.add_argument("--long-target", type=float, default=LONG_TARGET, help="긴 대기 하나가 영상에서 차지할 목표 초")
    ap.add_argument("--out", default="사번_성명_시연영상.mp4")
    ap.add_argument("--font", default=None)
    args = ap.parse_args(argv)
    need_ffmpeg()
    font = font_file(args.font)
    lo, hi = (float(x) for x in args.long_speed.split("-"))
    folder = Path(args.dir)
    takes = json.loads((folder / "takes.json").read_text(encoding="utf-8")) if (folder / "takes.json").is_file() else []
    take = next((t for t in takes if t["take"] == args.take), takes[-1] if takes else {})
    live = bool(take.get("live"))
    when = (take.get("started") or time.strftime("%Y-%m-%d"))[:10]

    parts = folder / ".parts"
    parts.mkdir(exist_ok=True)
    clips = [parts / "00-title.mp4"]
    title_card(clips[0], font, live, when)
    report = {}
    for sid in SCENES:
        src = folder / f"scene-{sid}.webm"
        if not src.is_file():
            print(f"장면 {sid}: 없음 (건너뜀)")
            continue
        mpath = folder / f"scene-{sid}.marks.json"
        mdata = json.loads(mpath.read_text(encoding="utf-8")) if mpath.is_file() else {}
        dst = parts / f"{sid}.mp4"
        report[sid] = encode_scene(src, mdata.get("marks", []), dst, args.speed, (lo, hi), font, live, mdata.get("seconds"),
                                   args.long_target)
        clips.append(dst)
        r = report[sid]
        speeds = ", ".join(f"{sp['end'] - sp['start']:.0f}초×1/{sp['speed']:g}" for sp in r["fast_spans"]) or "배속 없음"
        print(f"장면 {sid}: {r['source_seconds']}초 → {r['output_seconds']}초 ({speeds})")
    listing = parts / "list.txt"
    listing.write_text("".join(f"file '{c.resolve()}'\n" for c in clips), encoding="utf-8")
    out = folder / args.out
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy",
                    "-movflags", "+faststart", str(out)], check=True)
    info = probe(out)
    problems = check_submission(out, report)
    (folder / f"{out.stem}.json").write_text(json.dumps(
        {"take": take.get("take"), "live": live, "speed": args.speed, "long_speed": [lo, hi], "seconds": round(info["seconds"], 1),
         "bytes": out.stat().st_size, "format": info, "scenes": report, "problems": problems}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"완성: {out} ({info['seconds'] / 60:.2f}분 · {out.stat().st_size / 1024 / 1024:.1f}MB · "
          f"{info['width']}×{info['height']} {info['codec']} {info['fps']:.0f}fps · {'실제 호출' if live else '가짜 AI 리허설'})")
    if problems:
        print("✕ 제출 기준 미달:\n  " + "\n  ".join(problems))
        sys.exit(1)
    print("✓ 제출 기준 통과 (5분 이내 · 500MB 이하 · 1080p H.264 30fps)")


if __name__ == "__main__":
    main()
