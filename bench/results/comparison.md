# cloudcli end-to-end benchmark — after-r2

Fixture: **standard** (seed 20260815) — 6 projects, 54 conversations, 7,402 transcript rows (4.5 MB).

11 iterations (+2 warmup) on chromium 131.0.6778.33, node v22.23.2, 16 CPUs.

| flow | median before | median after | Δ median | min before | min after | Δ min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `app_boot` | 456.2 ms | 376.4 ms | -17.5% | 357.3 ms | 335.8 ms | -6.0% |
| `new_conversation` | 121.7 ms | 118.7 ms | -2.5% | 112.4 ms | 113.3 ms | +0.8% |
| `typing` | 341.6 ms | 319.9 ms | -6.4% | 310.6 ms | 312.1 ms | +0.5% |
| `switch_to_large_conversation` | 378.4 ms | 352.1 ms | -7.0% | 350.2 ms | 327.6 ms | -6.5% |
| `switch_to_typical_conversation` | 284.3 ms | 213.9 ms | -24.8% | 258.2 ms | 202 ms | -21.8% |
| `switch_back_warm` | 596.3 ms | 472 ms | -20.8% | 576.4 ms | 423 ms | -26.6% |
| `bug_report` | 145.1 ms | 153.3 ms | +5.7% | 141.6 ms | 144.6 ms | +2.1% |
| `chat_turn_in_large_conversation` | 1229.5 ms | 946.7 ms | -23.0% | 1176.7 ms | 913.5 ms | -22.4% |
| `chat_turn` | 779.3 ms | 812.7 ms | +4.3% | 725.4 ms | 760.2 ms | +4.8% |

### `app_boot`

Cold load of the app until the composer and conversation list are usable

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| navigation_to_interactive | 340.4 ms | 462.5 ms | 0 ms |
| interactive_to_idle | 35.2 ms | 43.4 ms | 0 ms |

### `new_conversation`

Start a new conversation from the sidebar picker

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| open_picker | 15.1 ms | 18.7 ms | 0 ms |
| pick_project | 105 ms | 120 ms | 0 ms |

### `typing`

Type an 86-character message into the composer

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| input_handling | 319.9 ms | 417.1 ms | 11.9 ms |

### `switch_to_large_conversation`

Open a 2,511-row / 1546 KB conversation from the sidebar

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| click_to_transcript | 287.2 ms | 321.5 ms | 0 ms |
| transcript_to_settled | 65.9 ms | 84.7 ms | 0 ms |

### `switch_to_typical_conversation`

Open a 85-row / 50 KB conversation from the sidebar

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| click_to_transcript | 213.9 ms | 259.7 ms | 0 ms |
| transcript_to_settled | 0 ms | 51.7 ms | 0 ms |

### `switch_back_warm`

Return to a conversation already visited in this session

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| click_to_transcript | 191.2 ms | 250.7 ms | 0 ms |
| transcript_to_settled | 280.2 ms | 380.6 ms | 160 ms |

### `bug_report`

Open the bug reporter and expand the context it captured

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| open_dialog | 146.7 ms | 205 ms | 0 ms |
| expand_context | 7.6 ms | 10.2 ms | 0 ms |

### `chat_turn_in_large_conversation`

Send a message inside a 2,511-row / 1546 KB conversation and watch the turn finish

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| send_to_echo | 274.7 ms | 290.7 ms | 0 ms |
| echo_to_first_token | 27.7 ms | 30.4 ms | 16.9 ms |
| first_token_to_complete | 660.2 ms | 758.4 ms | 533 ms |
| complete_to_settled | 0 ms | 0 ms | 0 ms |

### `chat_turn`

Send a message in a new conversation and watch the reply stream in and the run finish

| step | median | p95 | main-thread blocked |
| --- | ---: | ---: | ---: |
| send_to_echo | 298.7 ms | 376.3 ms | 110 ms |
| echo_to_first_token | 207.6 ms | 239.9 ms | 0 ms |
| first_token_to_complete | 262.8 ms | 475.3 ms | 0 ms |
| complete_to_settled | 0 ms | 0 ms | 0 ms |

