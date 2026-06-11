# OOM — gameplay (~18 s): mid-run via --warp, cold fetch, evict/pin, quit.
# Render from the repo root: vhs assets/play.tape
Output "/tmp/oom-play.gif"
Set FontSize 13
Set Width 1100
Set Height 560
Set Padding 10
Set TypingSpeed 30ms

Type "/Users/ran/.bun/bin/bun src/cli.ts play --seed 7 --warp 300"
Enter
Sleep 3.2s
Type "k"
Sleep 800ms
Type "f"
Sleep 2.5s
Type "j"
Sleep 600ms
Type "d"
Sleep 2.5s
Type "p"
Sleep 1.2s
Type "f"
Sleep 3s
Type "q"
Sleep 400ms
Type "q"
Sleep 600ms
