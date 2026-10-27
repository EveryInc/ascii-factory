Output of `node test/new-task-eval.mjs --runs 5`, 2026-10-27, with the CHECK_SYSTEM on this branch (unchanged since). "new" is this branch's prompt; "old" is main's, run on the same inputs in the same run.

# new_task eval

Check writer: sonnet · low. 5 runs each. Judged ("new"): CHECK_SYSTEM in the working tree. Compared with ("old"): main.

## Gate 1: single follow-ups

| Follow-up | Expected | New prompt | Requests (new) | Old prompt |
|---|---|---|---|---|
| make it a dog | new_task (a dog) | new_task 5 | a dog; /ascii a dog; a dog; /ascii a dog; /ascii a dog | steering 5 |
| make it smaller, simpler and make it a dog | new_task (a dog) | new_task 5 | /ascii a dog; a dog; /ascii a dog; /ascii a dog; a dog | steering 5 |
| now draw a house | new_task (a house) | new_task 5 | /ascii a house; a house; a house; a house; /ascii a house | unrelated 5 |
| can you do a tiger instead | new_task (a tiger) | new_task 5 | /ascii a tiger; /ascii a tiger; /ascii a tiger; a tiger; /ascii a tiger | steering 4, unrelated 1 |
| do a lighthouse instead | new_task (a lighthouse) | new_task 5 | a lighthouse; a lighthouse; /ascii a lighthouse; a lighthouse; a lighthouse | steering 5 |
| add a hat | steering | steering 5 | – | steering 5 |
| make it bigger | steering | steering 5 | – | steering 5 |
| draw it sitting on a fence | steering | steering 5 | – | steering 5 |
| add a chimney with smoke | steering | steering 5 | – | steering 5 |
| make it a kitten | steering | steering 5 | – | steering 5 |
| add its owner next to it | steering | steering 5 | – | steering 5 |
| thanks, looks good | comment | comment 5 | – | comment 5 |
| why did you use @ for the eye? | comment | comment 5 | – | comment 5 |
| claude mcp add --transport http toy-loop http://localhost:4488/mcp | unrelated | unrelated 5 | – | unrelated 5 |
| can you fix the failing test in auth.ts | unrelated | unrelated 5 | – | unrelated 5 |
| summarize this email thread for me (held out) | unrelated | unrelated 5 | – | unrelated 5 |
| write a SQL query that counts active users (held out) | unrelated | unrelated 5 | – | unrelated 5 |
| what's on my calendar tomorrow? (held out) | unrelated | unrelated 5 | – | unrelated 5 |
| draw a cat and a dog together | report only | new_task 4, steering 1 | a cat and a dog together; a cat and a dog together; a cat and a dog together; a cat and a dog together | steering 5 |
| make it a lion | report only | new_task 5 | /ascii a lion; /ascii a lion; /ascii a lion; /ascii a lion; a lion | steering 5 |

## Gate 2: steering only

| Step | Follow-up | Labels (new) | Labels (old) | Checks kept, new | Checks kept, old | Checks, new | Checks, old |
|---|---|---|---|---|---|---|---|
| 0 | /ascii a coffee mug | – | – | – | – | 4, 3, 3, 3, 3 | 3, 3, 3, 3, 3 |
| 1 | make it bigger | steering 5 | steering 5 | 16 of 16 | 15 of 15 | 6, 5, 5, 5, 5 | 5, 5, 5, 5, 5 |
| 2 | add steam coming out of the top | steering 5 | steering 5 | 21 of 26 | 21 of 25 | 7, 6, 6, 6, 6 | 6, 6, 6, 6, 6 |
| 3 | it should be at least 12 lines tall | steering 5 | steering 5 | 26 of 31 | 25 of 30 | 7, 6, 6, 6, 6 | 6, 6, 6, 6, 6 |
| 4 | less cluttered, fewer characters inside the mug | steering 5 | steering 5 | 31 of 31 | 30 of 30 | 8, 7, 7, 7, 7 | 7, 7, 7, 7, 7 |
| 5 | thanks, looks good | comment 5 | comment 5 | 36 of 36 | 35 of 35 | 8, 7, 7, 7, 7 | 7, 7, 7, 7, 7 |

## Gates

| Check | Pass | Result |
|---|---|---|
| Clear refinements: no splits | yes | 0 of 20 |
| Borderline: at most 1 split in 6 | yes | 0 of 10 |
| New tasks: caught in most runs | yes | 25 of 25 |
| Requests: no preferences, right form | yes | all clean |
| Comments: as with the old prompt | yes | 10 of 10 (old 10) |
| Held-out unrelated: labeled unrelated | yes | 15 of 15 |
| Unrelated: as with the old prompt | yes | 25 of 25 (old 25) |
| No split or unrelated, ever | yes | 0 of 25 |
| "thanks, looks good" is a comment | yes | comment, comment, comment, comment, comment |
| "at least 12 lines" kept exactly | yes | new 5 of 5, old 5 of 5 |
| Untouched checks kept, as often as before | yes | new 90%, old 91% |

Steer coverage in gate 2 (does each steer show up in a check?) is read by hand from the side-by-side checks in the JSON results.
