# OOM — full live-LLM round (English), par-bot pilot, real time ~3 min.
# Render: vhs assets/play-llm-en.tape ; post-process to 4x GIF (see assets/README note)
Output "/tmp/oom-llm-en.mp4"
Set FontSize 13
Set Width 1100
Set Height 560
Set Padding 10

Type "/Users/ran/.bun/bin/bun src/cli.ts play --llm --pilot par --seed 7"
Enter
Sleep 193s
Type "q"
Sleep 1s
Type "q"
Sleep 1.5s
